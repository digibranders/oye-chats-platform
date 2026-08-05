import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';
import { router } from './routes';

/**
 * Guards the failure mode that produced the post-signup 404: Admin 2.0 renamed
 * the information architecture, but the paths other code redirects to were
 * never updated, so real users were sent to routes that no longer existed.
 *
 * These assertions run against the REAL router config (not a synthetic
 * `<Routes>` tree), so they also cover route ranking - a legacy alias is only
 * useful if it out-ranks the in-shell `*` splat that renders the 404 page.
 */

/** The route path React Router settles on for `pathname`. */
function matchedPath(pathname: string): string | undefined {
  const matches = matchRoutes(router.routes, pathname);
  return matches?.[matches.length - 1]?.route.path;
}

describe('legacy path aliases', () => {
  // Old dashboard URLs that still arrive from delivered emails, push
  // notification `click_url`s and bookmarks. Each must match its own alias
  // route rather than falling through to the 404 splat.
  it.each(['/build', '/support', '/billing', '/affiliate', '/knowledge'])(
    'resolves %s to a real route instead of the 404 splat',
    (path) => {
      expect(matchedPath(path)).toBe(path);
    },
  );
});

describe('post-authentication landing routes', () => {
  // Every destination the auth pages can send a user to. `/build` living here
  // (as the *old* value) is what produced the reported bug: Google sign-up
  // redirected a brand-new account to a route that did not exist.
  it.each([
    ['dashboard root', '/'],
    ['new-account onboarding (OAuthCallback, VerifyEmail)', '/launch'],
    ['operator console (Login, Register)', '/inbox'],
    ['affiliate-only accounts (OAuthCallback)', '/workspace/affiliate'],
  ])('%s → %s exists', (_label, path) => {
    expect(matchedPath(path)).not.toBe('*');
  });
});
