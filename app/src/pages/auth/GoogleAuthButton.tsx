import { useState } from 'react';
import { Button } from '../../ui';
import { GOOGLE_AUTH_BASE_URL, useGoogleAuthAvailable } from './useGoogleAuth';

export interface GoogleAuthButtonProps {
  /** Visible label. The only copy difference between sign-in and sign-up. */
  label?: string;
  /** Relative path to land on afterwards, carried through the round trip. */
  next?: string;
  /** Telemetry only — the backend behaves identically either way. */
  mode?: 'login' | 'register';
  /**
   * Campaign and partner codes captured from the page's query string.
   *
   * OAuth is a full-page round trip through Google, so these have to ride the
   * backend's signed state or the attribution is gone by the time the callback
   * creates the account.
   */
  promoCode?: string;
  referralCode?: string;
  className?: string;
}

/**
 * Sign in, or sign up, with Google.
 *
 * The capability probe is `useGoogleAuth`'s, not this file's. Both sign-in
 * screens have to ask the same question — the button hides itself when the
 * deployment has no OAuth client, and a component cannot report "I rendered
 * nothing" to the parent drawing the "or" divider above it — so the probe was
 * written out twice, in two files, under one cache key. One module owns it now.
 *
 * A real full-page navigation rather than a popup: the OAuth dance has to
 * happen at the top level so Google's redirect lands on a URL the router can
 * read. The click is therefore one-way, which is why the button latches into a
 * loading state instead of staying pressable.
 */
export function GoogleAuthButton({
  label = 'Continue with Google',
  next = '/',
  mode = 'login',
  promoCode = '',
  referralCode = '',
  className,
}: GoogleAuthButtonProps) {
  const [leaving, setLeaving] = useState(false);
  // Render nothing until the probe answers, and nothing at all if the answer is
  // no. Showing the button first and removing it afterwards moves the email
  // form under the pointer at the moment someone is reaching for it.
  const available = useGoogleAuthAvailable();

  if (!available) return null;

  const handleClick = () => {
    if (leaving) return;
    setLeaving(true);
    const params = new URLSearchParams({ next, mode });
    if (promoCode) params.set('promo_code', promoCode);
    if (referralCode) params.set('referral_code', referralCode);
    window.location.href = `${GOOGLE_AUTH_BASE_URL}/auth/google/login?${params.toString()}`;
  };

  return (
    <Button
      variant="secondary"
      size="lg"
      block
      loading={leaving}
      onClick={handleClick}
      iconLeft={<GoogleMark />}
      className={className}
    >
      {label}
    </Button>
  );
}

/**
 * The official Google "G".
 *
 * Inlined rather than fetched so the sign-in page still renders when Google's
 * CDN is unreachable — which is exactly the network condition under which
 * someone reaches for the email form instead.
 *
 * The four hex values are the only ones in this surface. They are Google's
 * brand asset, reproduced under its identity guidelines, and are not ours to
 * substitute with a design token.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden className="h-4 w-4 shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9091c1.7018-1.5668 2.6832-3.8741 2.6832-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.8059 5.9564-2.1809l-2.9091-2.2581c-.8059.5404-1.8368.86-3.0473.86-2.3441 0-4.3282-1.5832-5.0359-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.9641 10.71c-.18-.5404-.2823-1.1186-.2823-1.71s.1023-1.1695.2823-1.71V4.9582H.9573C.3477 6.1727 0 7.5477 0 9s.3477 2.8273.9573 4.0418L3.9641 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.3459l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"
      />
    </svg>
  );
}

export default GoogleAuthButton;
