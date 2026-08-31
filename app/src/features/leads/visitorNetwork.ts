/**
 * Reading the IP-intelligence blob a session or lead carries.
 *
 * Apart from the component that renders it because two surfaces need the
 * *question* — is there anything here worth showing? — without rendering
 * anything: the Leads drawer, which chooses between a signal and "no network
 * details resolved", and the inbox's visitor profile, which stores the signal
 * only when there is one. A component returning `null` is still a truthy
 * element to its caller, so the test cannot be made by rendering it.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Is there anything worth rendering in this IP signal? */
export function hasNetworkSignal(intel: Record<string, unknown>): boolean {
  return Boolean(
    asText(intel.company_name) ||
      asText(intel.asn_org) ||
      intel.is_vpn === true ||
      intel.is_proxy === true ||
      intel.is_tor === true,
  );
}
