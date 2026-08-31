import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccessSection } from './AccessSection';
import {
  sessionShareDomainError,
  toAccessPayload,
  accessChanged,
  parseAccess,
} from './accessModel';

/**
 * The origin allow-list and the session-continuity parent, as rows on Deploy
 * under that page's single draft — not as the hand-rolled per-card save
 * contracts they were the last time they lived on this page.
 *
 * The lock-out confirmation sits on the page's save action and is covered by
 * `DeployPage.test.tsx`; what is covered here is that the controls still
 * normalise the way the server does and still refuse a value it would reject.
 */

const base = {
  website: 'https://www.acme.com',
  domains: [] as string[],
  domainCheckEnabled: false,
  sessionShareDomain: '',
};

/** A host that owns the draft, because the real page does. */
function Harness(props: Partial<typeof base> & { onChange?: (patch: unknown) => void }) {
  const [draft, setDraft] = useState({ ...base, ...props });
  return (
    <AccessSection
      website={draft.website}
      domains={draft.domains}
      domainCheckEnabled={draft.domainCheckEnabled}
      sessionShareDomain={draft.sessionShareDomain}
      onChange={(patch) => {
        props.onChange?.(patch);
        setDraft((previous) => ({
          ...previous,
          ...(patch.allowedDomains ? { domains: patch.allowedDomains } : {}),
          ...(patch.domainCheckEnabled !== undefined
            ? { domainCheckEnabled: patch.domainCheckEnabled }
            : {}),
          ...(patch.sessionShareDomain !== undefined
            ? { sessionShareDomain: patch.sessionShareDomain }
            : {}),
        }));
      }}
    />
  );
}

describe('the allow-list', () => {
  it('adds a domain from the keyboard and normalises it the way the server will', async () => {
    render(<Harness />);
    // Named by the `SettingRow`'s visible label. `TagInput`'s own `label` is the
    // fallback for when it is used outside one.
    const input = screen.getByRole('textbox', { name: 'Domains' });
    await userEvent.type(input, 'https://WWW.Acme.com/pricing{Enter}');
    expect(screen.getByRole('button', { name: 'Remove acme.com' })).toBeInTheDocument();
  });

  it('explains a rejected entry instead of silently dropping it', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Domains' }), 'nonsense{Enter}');
    expect(screen.getByText(/is not a domain/i)).toBeInTheDocument();
  });

  it('offers the apex and the wildcard together, because www is a subdomain', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: /Add acme\.com and \*\.acme\.com/ }));
    expect(screen.getByRole('button', { name: 'Remove acme.com' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove *.acme.com' })).toBeInTheDocument();
  });

  it('reports the enable flag through the draft rather than saving on the spot', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /Only allow the domains/i }));
    expect(onChange).toHaveBeenCalledWith({ domainCheckEnabled: true });
  });
});

describe('session continuity', () => {
  it('presents a working feature as working, not as unconfigured', () => {
    render(<Harness website="https://acme.com" />);
    expect(screen.getByText(/^Automatic/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('rejects a wildcard with the reason it cannot work, before any request', async () => {
    render(<Harness website="https://acme.com" />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Pin a parent domain' }), '*.acme.com');
    expect(screen.getByText(/A wildcard will not work here/)).toBeInTheDocument();
  });

  it('reports that a parent is pinned, and leaves the value in the field', () => {
    render(<Harness website="https://acme.com" sessionShareDomain="acme.com" />);
    // The badge carries the STATE. Naming the domain in it clipped even a short
    // one against `Badge`'s `max-w-40`, and the field below already holds it.
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Pin a parent domain' })).toHaveValue('acme.com');
  });
});

describe('the access payload', () => {
  it('normalises a pinned parent the way the backend stores it', () => {
    const draft = { ...parseAccess({}), sessionShareDomain: 'https://www.acme.com/' };
    expect(toAccessPayload(draft).session_share_domain).toBe('acme.com');
  });

  it('clears the override with an empty string rather than omitting the field', () => {
    const draft = { ...parseAccess({}), sessionShareDomain: '   ' };
    expect(toAccessPayload(draft)).toHaveProperty('session_share_domain', '');
  });

  it('is not sent when nothing in the slice moved', () => {
    const loaded = parseAccess({ allowed_domains: ['acme.com'], domain_check_enabled: true });
    expect(accessChanged(loaded, loaded)).toBe(false);
    expect(accessChanged({ ...loaded, allowedDomains: ['other.com'] }, loaded)).toBe(true);
  });

  it('accepts an empty pin, because continuity never turns off', () => {
    expect(sessionShareDomainError('')).toBeNull();
    expect(sessionShareDomainError('acme.com')).toBeNull();
    expect(sessionShareDomainError('*.acme.com')).toMatch(/wildcard/i);
    expect(sessionShareDomainError('nonsense')).toMatch(/not a domain/i);
  });
});
