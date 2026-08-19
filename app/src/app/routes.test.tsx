import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';
import { router } from './routes';

/**
 * Guards the failure mode that produced a live post-signup 404: the previous
 * rebuild renamed the information architecture and never updated the paths other
 * code redirects to, so real users were sent to routes that no longer existed.
 *
 * These assertions run against the REAL router config rather than a synthetic
 * `<Routes>` tree, so they also cover ranking — an alias is only useful if it
 * out-ranks the in-shell `*` splat that renders the 404 page.
 */

/** The route path React Router settles on for `pathname`. */
function matchedPath(pathname: string): string | undefined {
  const matches = matchRoutes(router.routes, pathname);
  return matches?.[matches.length - 1]?.route.path;
}

describe('the current information architecture', () => {
  it.each([
    ['home', '/'],
    ['setup checklist', '/setup'],
    ['chatbot list', '/chatbots'],
    ['chatbot overview', '/chatbots/7/overview'],
    ['chatbot knowledge', '/chatbots/7/knowledge'],
    ['chatbot experience', '/chatbots/7/experience'],
    ['chatbot deploy', '/chatbots/7/deploy'],
    ['chatbot qualification', '/chatbots/7/qualification'],
    ['chatbot behaviour', '/chatbots/7/behaviour'],
    ['inbox', '/inbox'],
    ['leads', '/leads'],
    ['analytics', '/analytics'],
    ['analytics journey', '/analytics/journey'],
    ['billing', '/billing'],
    ['usage', '/billing/usage'],
    ['reports', '/billing/reports'],
    ['workspace settings', '/settings/workspace'],
    ['team', '/settings/team'],
    ['integrations', '/settings/integrations'],
    ['developers', '/settings/developers'],
    ['affiliate', '/settings/affiliate'],
    ['your account', '/account'],
  ])('resolves the %s route', (_name, path) => {
    expect(matchedPath(path)).not.toBe('*');
  });
});

describe('moved URLs', () => {
  /**
   * Every path the previous IA shipped. These live in delivered emails, push
   * payloads and bookmarks, so each has to out-rank the 404 splat — including
   * the two the last rename dropped on the floor.
   */
  it.each([
    '/agents',
    '/agents/7',
    '/agents/7/overview',
    '/agents/7/knowledge',
    '/agents/7/experience',
    '/agents/7/channels',
    '/agents/7/advanced',
    '/agents/7/analytics',
    '/journey',
    '/support',
    '/build',
    '/launch',
    '/launch/welcome',
    '/workspace',
    '/workspace/general',
    '/workspace/members',
    '/workspace/billing',
    '/workspace/usage',
    '/workspace/reports',
    '/workspace/api-keys',
    '/workspace/integrations',
    '/workspace/affiliate',
    '/workspace/settings',
    '/workspace/security',
  ])('carries %s onto a real route rather than the 404 splat', (path) => {
    expect(matchedPath(path)).not.toBe('*');
  });
});

describe('the 404 splat', () => {
  it('still catches a genuinely unknown path', () => {
    expect(matchedPath('/definitely-not-a-page')).toBe('*');
  });
});
