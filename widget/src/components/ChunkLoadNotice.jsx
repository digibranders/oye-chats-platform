import React from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Inline fallback shown when a lazy widget chunk (handoff form, lead capture,
 * meeting booking) fails to load. Keeps the surrounding chat alive and gives the
 * visitor a one-tap retry instead of the whole widget disappearing.
 *
 * `onRetry` comes from the ErrorBoundary — it clears the error and re-mounts the
 * lazy child, which re-attempts the dynamic import (paired with lazyWithRetry's
 * backoff, this recovers from transient CDN/network blips).
 */
const ChunkLoadNotice = ({ onRetry, message = "Couldn't load this just now." }) => (
    <div className="mx-3 my-2 rounded-2xl border border-gray-100 bg-white p-3 max-w-xs">
        <p className="text-[12px] text-gray-500 leading-snug">{message}</p>
        {onRetry && (
            <button
                type="button"
                onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
                <RefreshCw className="w-3 h-3" />
                Try again
            </button>
        )}
    </div>
);

export default ChunkLoadNotice;
