import { useEffect, useReducer } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Globe, ExternalLink, AlertCircle, FileStack, Hash } from 'lucide-react';
import { getDocumentPages } from '../services/api';
import { cn } from '../lib/utils';

const initialFetchState = { loading: false, data: null, error: null };

function fetchReducer(state, action) {
  switch (action.type) {
    case 'RESET':   return initialFetchState;
    case 'LOADING': return { loading: true, data: null, error: null };
    case 'SUCCESS': return { loading: false, data: action.payload, error: null };
    case 'ERROR':   return { loading: false, data: null, error: action.payload };
    default:        return state;
  }
}

/**
 * Slide-in drawer that lists every page URL crawled from a website source.
 *
 * @param {string|null} sourceUrl  - Normalized root domain (e.g. "fynix.digital").
 *                                   Pass null to hide the drawer.
 * @param {number|null} botId      - Active bot ID for scoping the query.
 * @param {Function}    onClose    - Called when the drawer should be dismissed.
 */
export default function SourcePagesDrawer({ sourceUrl, botId, onClose }) {
  const [{ loading, data, error }, dispatch] = useReducer(fetchReducer, initialFetchState);

  const fetchPages = (source, bot) => {
    dispatch({ type: 'LOADING' });
    getDocumentPages(source, bot)
      .then((result) => dispatch({ type: 'SUCCESS', payload: result }))
      .catch((err) => dispatch({ type: 'ERROR', payload: err.message || 'Failed to load pages' }));
  };

  // Fetch pages whenever the source changes
  useEffect(() => {
    if (!sourceUrl) {
      dispatch({ type: 'RESET' });
      return;
    }
    fetchPages(sourceUrl, botId);
  }, [sourceUrl, botId]);

  // Close on Escape key
  useEffect(() => {
    if (!sourceUrl) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sourceUrl, onClose]);

  /**
   * Derive a short relative path label from a full URL.
   * "https://fynix.digital"        → "/"
   * "https://fynix.digital/about"  → "/about"
   */
  const toPath = (url) => {
    try {
      const { pathname, search } = new URL(url);
      const path = pathname + search;
      return path || '/';
    } catch {
      return url;
    }
  };

  return (
    <AnimatePresence>
      {sourceUrl && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Drawer panel */}
          <motion.aside
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 300 }}
            className="fixed inset-y-0 right-0 z-50 w-full max-w-[560px] flex flex-col bg-white dark:bg-surface-950 border-l border-surface-200 dark:border-surface-800 shadow-2xl"
            role="dialog"
            aria-label={`Crawled pages for ${sourceUrl}`}
          >
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-surface-200 dark:border-surface-800 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-xl bg-sky-50 dark:bg-sky-500/10 text-sky-500 shrink-0">
                  <Globe size={18} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-surface-900 dark:text-white truncate">
                    {sourceUrl}
                  </h2>
                  <p className="text-xs text-surface-400 mt-0.5">
                    {loading
                      ? 'Loading pages…'
                      : data
                        ? `${data.total_pages} page${data.total_pages !== 1 ? 's' : ''} · ${data.total_chunks} chunk${data.total_chunks !== 1 ? 's' : ''} crawled`
                        : 'Crawled pages'}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 p-1.5 rounded-lg text-surface-400 hover:text-surface-700 dark:hover:text-white hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors cursor-pointer"
                aria-label="Close drawer"
              >
                <X size={16} />
              </button>
            </div>

            {/* ── Body ── */}
            <div className="flex-1 overflow-y-auto">

              {/* Loading skeleton */}
              {loading && (
                <div className="divide-y divide-surface-100 dark:divide-surface-800 animate-pulse">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4 px-6 py-4">
                      <div className="h-3 bg-surface-200 dark:bg-surface-800 rounded w-2/5" />
                      <div className="h-3 bg-surface-200 dark:bg-surface-800 rounded w-1/4 ml-auto" />
                      <div className="h-3 bg-surface-200 dark:bg-surface-800 rounded w-10" />
                    </div>
                  ))}
                </div>
              )}

              {/* Error state */}
              {!loading && error && (
                <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
                  <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/10 text-rose-500">
                    <AlertCircle size={20} />
                  </div>
                  <p className="text-sm font-medium text-surface-700 dark:text-surface-300">{error}</p>
                  <button
                    onClick={() => fetchPages(sourceUrl, botId)}
                    className="text-xs text-primary-600 dark:text-primary-400 hover:underline cursor-pointer"
                  >
                    Try again
                  </button>
                </div>
              )}

              {/* Empty state */}
              {!loading && !error && data && data.pages.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
                  <div className="p-3 rounded-xl bg-surface-100 dark:bg-surface-800 text-surface-400">
                    <FileStack size={20} />
                  </div>
                  <p className="text-sm font-medium text-surface-600 dark:text-surface-400">No pages found</p>
                  <p className="text-xs text-surface-400">This source may have been deleted or not yet crawled.</p>
                </div>
              )}

              {/* Pages table */}
              {!loading && !error && data && data.pages.length > 0 && (
                <>
                  {/* Column headers */}
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-6 py-2.5 border-b border-surface-100 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50 sticky top-0">
                    <span className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider">Path / Title</span>
                    <span className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider text-right">Chunks</span>
                    <span className="text-[10px] font-semibold text-surface-400 uppercase tracking-wider text-right w-6" />
                  </div>

                  <ul className="divide-y divide-surface-100 dark:divide-surface-800">
                    {data.pages.map((page, idx) => {
                      const path = toPath(page.url);
                      return (
                        <li
                          key={idx}
                          className="grid grid-cols-[1fr_auto_auto] gap-x-4 items-center px-6 py-3.5 hover:bg-surface-50 dark:hover:bg-surface-800/40 transition-colors duration-150 group"
                        >
                          {/* Path + title */}
                          <div className="min-w-0">
                            <span className="block text-xs font-mono text-sky-600 dark:text-sky-400 truncate leading-snug">
                              {path}
                            </span>
                            {page.title && (
                              <span className="block text-[11px] text-surface-400 truncate mt-0.5 leading-snug">
                                {page.title}
                              </span>
                            )}
                          </div>

                          {/* Chunk count */}
                          <div className="flex items-center gap-1 text-xs text-surface-400 shrink-0">
                            <Hash size={10} className="text-surface-300 dark:text-surface-600" />
                            <span>{page.chunk_count}</span>
                          </div>

                          {/* External link */}
                          <a
                            href={page.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              'p-1 rounded text-surface-300 dark:text-surface-600',
                              'hover:text-sky-500 dark:hover:text-sky-400 transition-colors duration-150',
                              'opacity-0 group-hover:opacity-100 cursor-pointer'
                            )}
                            aria-label={`Open ${page.url}`}
                          >
                            <ExternalLink size={12} />
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>

            {/* ── Footer stats ── */}
            {!loading && data && data.pages.length > 0 && (
              <div className="shrink-0 px-6 py-4 border-t border-surface-100 dark:border-surface-800 bg-surface-50 dark:bg-surface-900/50 flex items-center gap-4">
                <div className="flex items-center gap-1.5 text-xs text-surface-400">
                  <span className="font-semibold text-surface-700 dark:text-surface-300">{data.total_pages}</span>
                  pages indexed
                </div>
                <div className="w-px h-3 bg-surface-200 dark:bg-surface-700" />
                <div className="flex items-center gap-1.5 text-xs text-surface-400">
                  <span className="font-semibold text-surface-700 dark:text-surface-300">{data.total_chunks}</span>
                  total chunks
                </div>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
