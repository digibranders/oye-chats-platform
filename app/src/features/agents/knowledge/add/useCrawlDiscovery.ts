import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { discoverCrawlUrls, getCurrentUser } from '../../../../services/api';
import { keys } from '../../../../query/keys';
import { resolveWebsitePrefill } from '../../../../lib/websitePrefill';
import { useCrawl, type StartCrawlOptions } from '../../../../context/CrawlContext';
import type { CrawlDiscovery, KnowledgeSource } from '../../../../types/domain';
import { canonicalCrawlUrls } from '../CrawlPageTree';
import { errorMessage } from '../knowledge-api';
import {
  crawlBudgetOf,
  crawlPreflight,
  creditsForPages,
  isWebsiteSource,
  normalizeSiteUrl,
  rootDomainOf,
} from '../knowledge-model';
import { t as translateNow } from '../../../../i18n/i18n';
import { useEntitlements } from '../../../../hooks/useEntitlements';

export interface UseCrawlDiscoveryOptions {
  agentId: number;
  agentName: string;
  /** The chatbot's own stored website, captured when it was created. */
  agentWebsite: string | null;
  sources: readonly KnowledgeSource[];
  /** Called once our crawl finishes cleanly, so the page can refetch. */
  onChanged: () => void;
}

/**
 * The website flow's state machine, lifted out of its own render.
 *
 * `WebsiteFlow` was a 400-line component holding eleven pieces of local state
 * and two effects, and it took **seventeen props** — fourteen of which were the
 * `useCrawl()` context flattened into a prop list by a parent that had already
 * imported the same context two lines earlier. Everything here is either state
 * or a decision about spending credits, and none of it needs a `Card` rendered
 * to be tested.
 */
export function useCrawlDiscovery({
  agentId,
  agentName,
  agentWebsite,
  sources,
  onChanged,
}: UseCrawlDiscoveryOptions) {
  // The per-crawl cap wall names the trial by name, because on the trial the
  // cap IS the upsell rather than a number to work around.
  const { planSlug } = useEntitlements();
  const { crawl, startCrawl, cancelCrawl } = useCrawl();

  // The account's own website, read from the shared session cache rather than a
  // private fetch — `/auth/me` was being called from ten places with no cache
  // between them. A failure simply means no prefill, never a blocked field.
  const { data: account } = useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 5 * 60_000,
  });

  const trainedHosts = useMemo(
    () => new Set(sources.filter((s) => isWebsiteSource(s.name)).map((s) => rootDomainOf(s.name))),
    [sources],
  );

  /**
   * What to offer in the URL field — unless that site is already trained.
   *
   * The suppression is the point. A chatbot with no sources is here to train its
   * own website, and asking for a URL the create-chatbot modal already stored is
   * the product forgetting. A chatbot that already learned that site is here to
   * add something *else*, and handing back its own trained URL invites a second
   * full crawl of pages it already knows — routing around the previewed, diffed
   * re-train that exists for exactly that job.
   */
  const prefill = useMemo(() => {
    const resolved = resolveWebsitePrefill(agentWebsite, account?.website ?? null);
    if (!resolved) return '';
    return trainedHosts.has(rootDomainOf(normalizeSiteUrl(resolved))) ? '' : resolved;
  }, [agentWebsite, account?.website, trainedHosts]);

  const [url, setUrl] = useState(prefill);
  // A ref, not state: it gates the sync effect below and must never re-run it.
  const edited = useRef(false);
  const [useJs, setUseJs] = useState(false);
  const [discovery, setDiscovery] = useState<CrawlDiscovery | null>(null);
  /**
   * The last check failed to count the site at all.
   *
   * Kept apart from `discovery` on purpose. The failure path used to store a
   * synthetic `{ total_found: 0 }`, and everything downstream read it as a
   * real answer: `crawlBudgetOf` filled the missing fields with `balance ?? 0`
   * and `cost_per_page ?? 1`, so the cost well told a customer with 8,500
   * credits that their balance was 0 at 1 credit a page, and the footer
   * offered a disabled "Train on 0 pages". None of those numbers had been
   * read from anywhere. With no result stored there is no budget to render,
   * and the footer can offer the honest action instead.
   */
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A crawl with no bot scope is still ours until it says otherwise — an
  // unscoped in-flight crawl surfacing nowhere is worse than surfacing here.
  const crawlOwned = crawl.botId === null || crawl.botId === agentId;
  const crawlRunning = crawlOwned && (crawl.status === 'running' || crawl.status === 'cancelling');
  const crawlIsOurs = crawl.botId === agentId;

  // `agentWebsite` and `/auth/me` resolve independently and asynchronously, so
  // the initialiser alone is computed from `undefined` on a cold load and never
  // corrects itself. Re-sync when the resolved value changes — but never over
  // what the customer typed, including a field they deliberately cleared.
  useEffect(() => {
    if (edited.current || !prefill) return;
    setUrl(prefill);
  }, [prefill]);

  // Clear the form once our crawl finishes cleanly, so it is ready for the next
  // site. Keyed on the status transition, not derived during render.
  const crawlStatus = crawl.status;
  useEffect(() => {
    if (!crawlIsOurs || crawlStatus !== 'done') return;
    setUrl('');
    setDiscovery(null);
    setDiscoveryFailed(false);
    setSelected([]);
    setError(null);
    onChanged();
  }, [crawlIsOurs, crawlStatus, onChanged]);

  const budget = discovery ? crawlBudgetOf(discovery) : null;
  /**
   * Is there a real page list to pick from, or only the address we were given?
   *
   * `> 1`, not `> 0`. Server-side discovery always returns at least the seed
   * URL, so `> 0` was true for every site ever checked — which sent
   * `ordered_urls` on every crawl, which put the backend on its `fetch_urls`
   * branch, which never runs `crawl_website`, which is the only path to link
   * discovery and the recursive crawl. A client-rendered SPA with no sitemap
   * discovers exactly its homepage and was then crawled as exactly its
   * homepage, and the advice it produced ("turn on JavaScript") could not help,
   * because the page cap was never what limited it. With the list omitted the
   * backend falls through sitemap → link discovery → recursive crawl on its
   * own.
   */
  const hasPageList = (discovery?.urls?.length ?? 0) > 1;
  const pageCount = hasPageList ? selected.length : (discovery?.total_found ?? 0);
  const preflight = budget ? crawlPreflight(budget, Math.max(pageCount, 0), planSlug) : null;
  const cost = budget ? creditsForPages(budget, pageCount) : 0;

  const alreadyTrained = useMemo(() => {
    const trimmed = url.trim();
    if (!trimmed) return null;
    const host = rootDomainOf(normalizeSiteUrl(trimmed));
    return trainedHosts.has(host) ? host : null;
  }, [url, trainedHosts]);

  const editUrl = useCallback((next: string) => {
    edited.current = true;
    setUrl(next);
    setDiscovery(null);
    setSelected([]);
    setError(null);
  }, []);

  const setJavaScript = useCallback((next: boolean) => {
    setUseJs(next);
    setDiscovery(null);
    setSelected([]);
  }, []);

  const discover = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || discovering) return;
    setDiscovering(true);
    setError(null);
    setDiscovery(null);
    setDiscoveryFailed(false);
    setSelected([]);
    try {
      const result = await discoverCrawlUrls(normalizeSiteUrl(trimmed), agentId);
      setDiscovery(result);
      setSelected(canonicalCrawlUrls(result.urls ?? []));
    } catch (cause) {
      // Discovery is best-effort: a site with no sitemap is still crawlable by
      // following links, so a failure explains itself and leaves the path open
      // rather than blocking the only way to train a chatbot. It leaves NO
      // result behind, see `discoveryFailed`.
      setDiscoveryFailed(true);
      setError(
        errorMessage(
          cause,
          translateNow('agents.weCouldNotCountThe') || 'We could not count the pages on that site. You can still train on it, and we will follow links from the homepage.',
        ),
      );
    } finally {
      setDiscovering(false);
    }
  }, [agentId, discovering, url]);

  const beginCrawl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const options: StartCrawlOptions = {
        url: normalizeSiteUrl(trimmed),
        botId: agentId,
        botName: agentName,
        useJs,
      };
      if (hasPageList) {
        options.orderedUrls = selected;
        options.discoveredTotal = selected.length;
      } else if (discovery && discovery.total_found > 0) {
        options.discoveredTotal = discovery.total_found;
      }
      await startCrawl(options);
    } catch (cause) {
      setError(errorMessage(cause, translateNow('agents.weCouldNotStartTraining') || 'We could not start training. Please try again.'));
    }
  }, [agentId, agentName, discovery, hasPageList, selected, startCrawl, url, useJs]);

  const stopCrawl = useCallback(async () => {
    try {
      await cancelCrawl();
    } catch (cause) {
      setError(errorMessage(cause, translateNow('agents.weCouldNotStopTraining') || 'We could not stop training. Please try again.'));
    }
  }, [cancelCrawl]);

  return {
    crawl,
    crawlRunning,
    crawlIsOurs,
    url,
    editUrl,
    useJs,
    setJavaScript,
    discovery,
    discoveryFailed,
    discovering,
    selected,
    setSelected,
    error,
    budget,
    hasPageList,
    pageCount,
    preflight,
    cost,
    alreadyTrained,
    discover,
    beginCrawl,
    stopCrawl,
  };
}
