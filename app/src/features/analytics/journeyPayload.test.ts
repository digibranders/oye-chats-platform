import { describe, expect, it } from 'vitest';
import type {
  JourneyConversionPathsResponse,
  JourneyPostChatResponse,
  JourneyPreChatSequencesResponse,
  JourneyTopPagesResponse,
} from '../../services/api';
import { safePaths, safePostChat, safeSequences, safeTopPages } from './useJourneyData';

/**
 * The journey endpoints, when they disagree with their own types.
 *
 * Every other reader in this feature narrows its payload — `analytics-types.ts`
 * says why: "their server shape varies by plan and by API build… so a missing
 * key never crashes a card and never silently renders as `0`". These four were
 * typed and trusted, and a 200 that omitted `sequences` threw
 * `Cannot read properties of undefined (reading 'map')` out of a `useMemo` in
 * `JourneyFlow` — taking the whole route to the page error boundary rather than
 * showing an empty diagram.
 *
 * The casts below are the point of the test: the compiler believes the `.d.ts`,
 * and what is being defended against is the response that does not.
 */

describe('journey payloads survive a response missing its lists', () => {
  it('defaults the pre-chat sequences', () => {
    const raw = { period: '2026-08', total_sessions: 0, sessions_with_pre_chat: 0 };
    expect(safeSequences(raw as JourneyPreChatSequencesResponse).sequences).toEqual([]);
  });

  it('defaults every post-chat list', () => {
    const safe = safePostChat({ period: '2026-08' } as JourneyPostChatResponse);
    expect(safe.first_hops).toEqual([]);
    expect(safe.all_hops).toEqual([]);
    expect(safe.full_sequences).toEqual([]);
  });

  it('defaults the conversion paths', () => {
    expect(safePaths({} as JourneyConversionPathsResponse).paths).toEqual([]);
  });

  it('defaults the top-pages rows', () => {
    expect(safeTopPages({} as JourneyTopPagesResponse).rows).toEqual([]);
  });

  it('leaves a well-formed payload alone', () => {
    const rows = [{ path: '/pricing', sessions: 4, share: 0.4 }];
    expect(safeTopPages({ rows } as unknown as JourneyTopPagesResponse).rows).toEqual(rows);
  });

  it('rejects a list-shaped field that is not a list', () => {
    // A `{}` where an array belongs passes `!= null` and fails `.map`, which is
    // the exact shape of the crash this guards.
    const raw = { sequences: {} } as unknown as JourneyPreChatSequencesResponse;
    expect(safeSequences(raw).sequences).toEqual([]);
  });
});
