import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader, Page, PageHeader, buttonClass } from '../../ui';
import { WORKSPACE_NAV } from '../../shell/nav';

/**
 * The address does not resolve.
 *
 * Rendered by the splat route inside the shell, so the rail stays put and the
 * URL stays in the address bar. The page it replaces was a silent redirect to
 * Home, which is worse than it sounds: a customer following a stale bookmark or
 * a mistyped link landed somewhere else with no explanation, and had no way to
 * tell whether the page had moved, been renamed, or never existed.
 *
 * A 404 is the one error where the way back is genuinely a menu, so it offers
 * the console's own destinations rather than a lone "Go home" — read straight
 * from the navigation, so a section added later appears here without anybody
 * remembering to add it.
 */
export function NotFoundPage() {
  return (
    <Page width="default">
      <PageHeader
        eyebrow="Error 404"
        title="We could not find that page"
        description="The address in your browser bar does not match anything in the console. It may have been renamed since the link was made, or there may be a typo in it."
        actions={
          <Link to="/" className={buttonClass('primary', 'md')}>
            Go to Home
          </Link>
        }
      />

      <Card>
        <CardHeader
          title="Try one of these instead"
          titleAs="h2"
          description="Everywhere in the console, from here."
        />
        <CardBody>
          <ul className="grid gap-1 sm:grid-cols-2">
            {WORKSPACE_NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover"
                >
                  <item.icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
                  <span className="min-w-0">
                    <span className="block text-base font-medium text-text-primary">
                      {item.label}
                    </span>
                    <span className="block text-xs text-text-secondary">{item.hint}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </Page>
  );
}
