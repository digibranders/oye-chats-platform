import React from 'react';

/**
 * Error boundary for the embedded widget.
 *
 * The widget is a single React tree rendered into a shadow root on a customer's
 * site. Before this boundary existed, ANY render-time throw (most commonly a
 * failed lazy chunk load ("Failed to fetch dynamically imported module")) would
 * propagate to the root and unmount the entire widget, so the whole chat simply
 * vanished from the visitor's screen. That is never acceptable: a single missing
 * or slow chunk must degrade locally, not take down the product.
 *
 * Wrap each lazy <Suspense> block with its own boundary so only the failing
 * sub-view degrades (e.g. the handoff form) while the rest of the chat keeps
 * working, and wrap the whole app with one top-level boundary as a last resort.
 *
 * Props:
 *   - fallback: ReactNode | (reset: () => void) => ReactNode
 *       Rendered when a descendant throws. A function receives a `reset` callback
 *       that clears the error and re-mounts the children (retry). Defaults to null
 *       (render nothing. Appropriate for headless/logic-only subtrees).
 *   - onError: (error, info) => void  optional side-effect hook.
 *   - label: string  short identifier included in the console log for triage.
 */
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        const label = this.props.label ? ` [${this.props.label}]` : '';
        console.error(`[OyeChats] error boundary${label} caught:`, error, info?.componentStack);
        // Report to Sentry if the host page (or our own lazy loader) has it.
        if (typeof window !== 'undefined' && window.Sentry?.captureException) {
            try {
                window.Sentry.captureException(error, { tags: { boundary: this.props.label || 'root' } });
            } catch {
                /* never let error reporting throw inside the boundary */
            }
        }
        if (typeof this.props.onError === 'function') {
            try {
                this.props.onError(error, info);
            } catch {
                /* swallow, a broken handler must not re-crash the boundary */
            }
        }
    }

    reset = () => {
        this.setState({ hasError: false });
    };

    render() {
        if (this.state.hasError) {
            const { fallback } = this.props;
            if (typeof fallback === 'function') return fallback(this.reset);
            return fallback ?? null;
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
