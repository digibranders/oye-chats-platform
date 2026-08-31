import { Alert, Tooltip } from '../../ui';
import { asText } from './visitorNetwork';

/**
 * The company the visitor's network resolves to, drawn once.
 *
 * It lives in its own module because two surfaces read the same field and must
 * not present it two ways: the Leads drawer, where it has always rendered, and
 * the inbox's visitor pane, where the operator talking to the visitor right now
 * could not see it at all. A second copy of these three lines is how a product
 * ends up asserting an employer in one place and hedging it in another.
 *
 * Callers decide whether to render it at all — see `hasNetworkSignal`.
 */
export function NetworkSignal({ intel }: { intel: Record<string, unknown> }) {
  const company = asText(intel.company_name);
  const domain = asText(intel.company_domain);
  const asn = asText(intel.asn_org);
  const masked = intel.is_vpn === true || intel.is_proxy === true || intel.is_tor === true;

  // `company_name` arrives already filtered: the API strips it for every
  // hosting range, ISP range and carrier brand, so anything reaching here is a
  // range somebody could actually be employed by. Two different things are
  // rendered — a company, or the network that routed them — never one hedged.
  // Not a box. The drawer is the surface; a section here is a heading and a
  // hairline, and this one already sits under both.
  return (
    <div className="space-y-2">
      {company ? (
        <div>
          <Tooltip content="Derived from the visitor’s network. Not a confirmed employer.">
            <p className="inline-block cursor-default text-base font-medium text-text-primary">
              {company}
            </p>
          </Tooltip>
          {domain ? <p className="break-all text-xs text-text-secondary">{domain}</p> : null}
        </div>
      ) : asn ? (
        <p className="text-prose text-text-secondary">
          Connecting via <span className="text-text-primary">{asn}</span>
        </p>
      ) : null}
      {masked ? <Alert tone="warning">VPN or proxy — signal unreliable.</Alert> : null}
    </div>
  );
}
