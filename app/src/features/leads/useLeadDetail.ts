/**
 * Everything the lead drawer needs, keyed by session id.
 *
 * Three separate reads rather than one, because they have genuinely different
 * lifetimes and failure modes:
 *
 * - the lead record itself (`GET /leads/{id}`), which the drawer cannot render
 *   without;
 * - the transcript, read from `GET /chat/history/{id}` with its `before` cursor
 *   rather than from the 100 messages the lead endpoint bundles. Those arrive
 *   with no ids, oldest-first and silently truncated, so a long conversation
 *   showed its beginning and hid its end — which is the half that matters;
 * - the conversation's post-chat rating, which lives on the operator session
 *   endpoint and is absent for every visitor who did not rate.
 *
 * A failure in the second or third does not take the drawer down with it.
 */
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getChatHistory,
  getLeadDetail,
  getSessionDetails,
  overrideLeadQualification,
} from '../../services/api';
import { keys } from '../../query/keys';
import type { ChatMessage, Lead } from '../../types/domain';

/**
 * A transcript message.
 *
 * The two endpoints that return messages disagree on the timestamp's name:
 * `GET /chat/history/{id}` sends `timestamp`, the lead endpoint sends
 * `created_at`. Both are declared so the renderer can read whichever arrived
 * rather than showing a blank clock on half the transcripts.
 */
export interface TranscriptMessage extends ChatMessage {
  timestamp?: string | null;
}

/** The lead record. The transcript is fetched separately, so it is not here. */
export type LeadDetail = Lead;

/** How many messages one transcript page holds. The endpoint's ceiling is 200. */
export const TRANSCRIPT_PAGE_SIZE = 40;

export interface LeadTranscript {
  messages: TranscriptMessage[];
  loading: boolean;
  error: Error | null;
  /** More messages exist before the oldest one on screen. */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  retry: () => void;
}

export interface QualificationOverride {
  dimension: string;
  score: number;
}

export interface LeadDetailData {
  detail: LeadDetail | null;
  loading: boolean;
  error: Error | null;
  retry: () => void;
  transcript: LeadTranscript;
  /** 1–5, or `null` when this visitor never rated the conversation. */
  visitorRating: number | null;
  /** Apply an operator score override to one qualification dimension. */
  overrideDimension: (override: QualificationOverride) => Promise<void>;
  overriding: boolean;
}

/**
 * The transcript's cursor.
 *
 * `GET /chat/history/{id}` returns the `limit` most recent messages before an
 * id, in chronological order — so the *first* message of a page is the cursor
 * for the page before it, and a short page means we have reached the beginning.
 */
function oldestId(page: TranscriptMessage[]): number | undefined {
  return page[0]?.id;
}

export function useLeadDetail(sessionId: string | null): LeadDetailData {
  const queryClient = useQueryClient();
  const enabled = sessionId !== null;
  const detailKey = keys.leads.detail(sessionId ?? '');

  const detail = useQuery<Lead>({
    queryKey: detailKey,
    queryFn: () => getLeadDetail(sessionId as string),
    enabled,
    staleTime: 60_000,
  });

  const transcript = useInfiniteQuery<TranscriptMessage[]>({
    // Derived from the registry's detail key so the whole drawer's cache is one
    // subtree and a single invalidation clears it.
    queryKey: [...detailKey, 'transcript'],
    queryFn: ({ pageParam }) =>
      getChatHistory(sessionId as string, {
        beforeId: pageParam as number | undefined,
        limit: TRANSCRIPT_PAGE_SIZE,
      }),
    initialPageParam: undefined as number | undefined,
    // Paging *backwards*: the first fetch is the tail of the conversation and
    // each further page is older, so the cursor is the oldest id seen so far.
    getNextPageParam: (lastPage) =>
      lastPage.length < TRANSCRIPT_PAGE_SIZE ? undefined : oldestId(lastPage),
    enabled,
    staleTime: 60_000,
  });

  /**
   * The post-chat rating. Its own query because it comes from a different route
   * and is genuinely optional — a workspace whose operator surface is
   * unavailable should still get the lead.
   */
  const session = useQuery<Record<string, unknown>>({
    queryKey: [...detailKey, 'session'],
    queryFn: () => getSessionDetails(sessionId as string),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const override = useMutation({
    mutationFn: ({ dimension, score }: QualificationOverride) =>
      overrideLeadQualification(sessionId as string, dimension, score),
    // The override rewrites the composite score and the tier, so the list page
    // the lead came from is stale too, not just the drawer.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  // Pages arrive newest-page-first, and each page is itself chronological, so
  // the render order is the reverse of the page order.
  const messages = (transcript.data?.pages ?? []).slice().reverse().flat();

  const loadEarlier = useCallback(() => {
    void transcript.fetchNextPage();
  }, [transcript]);

  const rawRating = session.data?.visitor_rating;
  const visitorRating = typeof rawRating === 'number' && rawRating > 0 ? rawRating : null;

  return {
    detail: detail.data ?? null,
    loading: detail.isPending && enabled,
    error: (detail.error as Error | null) ?? null,
    retry: () => {
      void detail.refetch();
      void transcript.refetch();
    },
    transcript: {
      messages,
      loading: transcript.isPending && enabled,
      error: (transcript.error as Error | null) ?? null,
      hasEarlier: transcript.hasNextPage,
      loadingEarlier: transcript.isFetchingNextPage,
      loadEarlier,
      retry: () => void transcript.refetch(),
    },
    visitorRating,
    overrideDimension: (next) => override.mutateAsync(next).then(() => undefined),
    overriding: override.isPending,
  };
}
