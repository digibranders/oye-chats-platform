import { forwardRef } from 'react';

/**
 * Credit-coin icon — a stroked coin outline with a bold "C" inside.
 * Drop-in replacement for the previous Lucide ``Coins`` icon used on the
 * Billing page and the top-up modal.
 *
 * Stylistic decisions:
 *   • Line-art (``fill="none"`` + ``stroke="currentColor"``) so the icon
 *     inherits the surrounding text color via Tailwind utilities like
 *     ``text-primary-500`` and adapts to dark mode without extra wiring.
 *   • Outer radius 8 / inner "C" radius 3 — matches the visual weight of
 *     other Lucide icons in the same row (Activity, Users, ListOrdered),
 *     which occupy roughly 67% of the 24px viewBox. A larger circle made
 *     the coin read "heavier" than its tab-row neighbors.
 *   • The "C" is a 270° arc opening to the right, rendered as a single
 *     path command so the file stays a single shape pair.
 */
const CreditCoin = forwardRef(function CreditCoin(
    { className = '', strokeWidth = 2, ...rest },
    ref,
) {
    return (
        <svg
            ref={ref}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
            focusable="false"
            {...rest}
        >
            <circle cx="12" cy="12" r="8" />
            <path d="M14 9.5 A3 3 0 1 0 14 14.5" />
        </svg>
    );
});

export default CreditCoin;
