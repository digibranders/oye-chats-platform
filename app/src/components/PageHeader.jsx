import { useEffect } from 'react';
import { usePageHeader } from '../context/PageHeaderContext';

/**
 * Headless primitive: a page renders this to publish its breadcrumbs, title,
 * and action buttons into the shared TopBar. Renders nothing itself.
 *
 * @param {Object}   props
 * @param {Array<{label: string, to?: string}>} [props.crumbs] - Breadcrumb
 *   trail; the LAST entry is treated as the page title by the TopBar.
 * @param {string}   [props.title]   - Page title (usually mirrors the last crumb).
 * @param {React.ReactNode} [props.actions] - Page actions (e.g. a Save button),
 *   rendered in the TopBar's slim action row.
 * @param {string}   [props.hint]    - Optional tooltip hint stored in context
 *   for future use (the TopBar may ignore it for now).
 */
export default function PageHeader({ crumbs = [], title = '', actions = null, hint = '' }) {
  const { setPageHeader } = usePageHeader();

  // Publish the header whenever the props change. No cleanup here so it doesn't
  // reset on every re-render (which would churn once pages publish `actions`).
  useEffect(() => {
    setPageHeader({ crumbs, title, actions, hint });
  }, [crumbs, title, actions, hint, setPageHeader]);

  // Reset back to the fallback header only when the publishing page unmounts so
  // a stale title/actions never leaks onto the next (un-migrated) page.
  useEffect(() => () => setPageHeader({ crumbs: [], title: '', actions: null, hint: '' }), [setPageHeader]);

  return null;
}
