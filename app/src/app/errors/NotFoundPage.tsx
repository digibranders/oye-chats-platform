import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader, Measure, Page, PageHeader, buttonClass } from '../../ui';
import { useWorkspace } from '../../context/WorkspaceContext';
import { WORKSPACE_NAV, navForRole, type NavItem } from '../../shell/nav';

export interface NotFoundPageProps {
  /**
   * The destinations to offer. Defaults to the workspace's, filtered by role.
   * The platform console passes its own.
   */
  nav?: readonly NavItem[];
  /** Where the primary action goes. */
  home?: string;
}

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
 * remembering to add it, and **filtered by role**, because it used to offer a
 * plain operator four destinations the router bounces them off.
 */
export function NotFoundPage({ nav, home = '/' }: NotFoundPageProps) {
  const { isOperator } = useWorkspace();
  const items = nav ?? navForRole(WORKSPACE_NAV, isOperator);

  return (
    <Page>
      <Measure width="reading">
        <PageHeader
          eyebrow="Error 404"
          title="We could not find that page"
          description="That address does not match anything in the console."
          actions={
            <Link to={home} className={buttonClass('primary', 'md')}>
              Go to Home
            </Link>
          }
        />

        <Card>
          <CardHeader title="Try one of these instead" titleAs="h2" />
          <CardBody>
            {/* Bled back to the header's column: the rows carried their own
                `px-3` inside a `px-cell` card, so every label sat twelve pixels
                right of the title above it and the hover rectangle floated in the
                middle of the card. */}
            <ul className="-mx-2 grid gap-0.5 sm:grid-cols-2">
              {items.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover"
                  >
                    <item.icon aria-hidden className="mt-0.5 h-icon-md w-icon-md shrink-0 text-text-tertiary" />
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
      </Measure>
    </Page>
  );
}
