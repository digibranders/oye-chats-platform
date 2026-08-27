import React from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from '../i18n/i18n.js';

/**
 * Inline fallback shown when a lazy widget chunk (handoff form, lead capture,
 * meeting booking) fails to load. Keeps the surrounding chat alive and gives the
 * visitor a one-tap retry instead of the whole widget disappearing.
 *
 * `onRetry` comes from the ErrorBoundary, it clears the error and re-mounts the
 * lazy child, which re-attempts the dynamic import (paired with lazyWithRetry's
 * backoff, this recovers from transient CDN/network blips).
 *
 * `message` is resolved by the CALLER, not defaulted to a raw English string
 * here: each call site knows which chunk failed and passes the matching
 * localized copy. The default below only covers a caller that supplies nothing.
 */
const ChunkLoadNotice = ({ onRetry, message }) => (
    <div className="mx-3 my-2 rounded-2xl border border-gray-100 bg-white p-3 max-w-xs">
        <p className="text-[12px] text-gray-500 leading-snug">
            {message || t('system.chunk_generic') || 'Couldn’t load this just now.'}
        </p>
        {onRetry && (
            <button
                type="button"
                onClick={onRetry}
                className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
                <RefreshCw className="w-3 h-3" />
                {t('system.try_again') || 'Try again'}
            </button>
        )}
    </div>
);

export default ChunkLoadNotice;
