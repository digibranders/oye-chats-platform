import React, { useEffect, useState } from 'react';
import { Play, FileDown } from 'lucide-react';

/**
 * MediaCard — inline chat card for a single YouTube video OR a downloadable
 * file. Rendered by MessageBubble beneath the bot's text when a message
 * carries a ``media_card`` property, which the backend injects into
 * FINAL_METADATA whenever the LLM emits ``[YOUTUBE_CARD:VIDEO_ID]`` or
 * ``[DOWNLOAD_CARD:URL|FILENAME]`` — see ``_extract_media_card`` in
 * ``platform/api/app/services/rag_service.py``.
 *
 * Minimal treatment (per product decision):
 *   - YouTube: thumbnail + video title + click-to-watch.
 *   - Download: file icon + filename + download button.
 * No channel name, no duration, no date — kept intentionally spare so the
 * card reads as an accent to the answer, not a takeover.
 *
 * Props:
 *   card: { type: 'youtube', video_id: string }
 *       | { type: 'download', url: string, name: string }
 */

// Cross-instance in-memory cache of resolved YouTube titles. Keyed by
// video_id so the same video only ever costs one oEmbed roundtrip in the
// lifetime of the widget script. Never hits localStorage — the widget runs
// in the customer's page and we don't want to reserve storage there.
const _ytTitleCache = new Map();

// oEmbed endpoint — free, keyless, CORS-enabled. Returns title, author_name,
// thumbnail_url, and a few others; we only read title. Failures fall back to
// a generic label so the card never blocks the answer.
const YT_OEMBED_URL = 'https://www.youtube.com/oembed';

// Format a video length (integer seconds) as ``M:SS`` — or ``H:MM:SS`` for
// videos an hour or longer. Returns ``null`` for anything unusable so the
// caller can conditionally omit the pill rather than render "NaN".
const _formatDuration = (totalSeconds) => {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
    const total = Math.floor(totalSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
};

const YouTubeCard = ({ videoId, durationSeconds, title: initialTitle }) => {
    const durationLabel = _formatDuration(durationSeconds);
    // A server-scraped title (populated at ingest time and passed through
    // FINAL_METADATA) always wins over the client-side oEmbed lookup —
    // it's already ready by the time the card mounts, so the title
    // renders in the same frame as the thumbnail instead of flickering
    // in a beat later. Prime the cache too so a subsequent re-render or
    // another card for the same video skips oEmbed entirely.
    const _serverTitle = typeof initialTitle === 'string' ? initialTitle.trim() : '';
    if (_serverTitle && !_ytTitleCache.has(videoId)) {
        _ytTitleCache.set(videoId, _serverTitle);
    }
    // React's official "reset state when a prop changes" pattern — track the
    // last ``videoId`` we rendered for, and if the incoming prop differs,
    // re-derive state during render. That keeps the state up-to-date on
    // prop change without calling setState in an effect (which React 19's
    // ``react-hooks/set-state-in-effect`` rule flags as a smell — cascading
    // renders when the value could just be derived synchronously).
    // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    const [renderedVideoId, setRenderedVideoId] = useState(videoId);
    const [title, setTitle] = useState(() => _ytTitleCache.get(videoId) || '');
    const [loading, setLoading] = useState(() => !_ytTitleCache.has(videoId));

    if (renderedVideoId !== videoId) {
        setRenderedVideoId(videoId);
        setTitle(_ytTitleCache.get(videoId) || '');
        setLoading(!_ytTitleCache.has(videoId));
    }

    useEffect(() => {
        // Cache hit — the state above is already correct; no fetch needed.
        if (_ytTitleCache.has(videoId)) return undefined;
        let cancelled = false;
        // Abort on unmount so a slow oEmbed request doesn't call setState on
        // a torn-down component (React warns on that in strict mode).
        const controller = new AbortController();
        const params = new URLSearchParams({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            format: 'json',
        });
        fetch(`${YT_OEMBED_URL}?${params.toString()}`, { signal: controller.signal })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`oEmbed ${r.status}`))))
            .then((data) => {
                if (cancelled) return;
                const resolved = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : '';
                _ytTitleCache.set(videoId, resolved);
                setTitle(resolved);
                setLoading(false);
            })
            .catch(() => {
                if (cancelled) return;
                // Cache the empty result too — no point re-fetching a video
                // whose oEmbed we know we cannot resolve (private, deleted,
                // region-locked). The card falls back to a generic label.
                _ytTitleCache.set(videoId, '');
                setTitle('');
                setLoading(false);
            });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [videoId]);

    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    // hqdefault.jpg is free and always available; guaranteed 480×360 and
    // renders sharply at the widget's card width (~300px).
    const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const displayTitle = loading ? '' : title || 'Watch on YouTube';

    return (
        <a
            href={watchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="oyechats-media-card oyechats-media-card--youtube mt-2 flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1"
            aria-label={loading ? 'Loading YouTube video' : `Watch on YouTube: ${displayTitle}`}
        >
            <div className="relative aspect-video w-full bg-gray-100">
                <img
                    src={thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                        // Fall back to the medium-quality still if hqdefault
                        // 404s (very rare — usually region blocks or takedowns).
                        if (!e.currentTarget.dataset.fallback) {
                            e.currentTarget.dataset.fallback = '1';
                            e.currentTarget.src = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
                        }
                    }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg">
                        <Play className="h-6 w-6 fill-current" aria-hidden="true" />
                    </span>
                </div>
                {/* Duration pill — bottom-right corner of the thumbnail,
                    matching YouTube's native duration overlay: solid black
                    fill, semibold white text, ~13px, generous horizontal
                    padding, small radius so the shape reads as a chip
                    rather than a full pill. Only rendered when the backend
                    supplied ``duration_seconds`` on the card payload
                    (populated from metadata captured at ingestion time); no
                    pill when missing so the card degrades gracefully for
                    legacy chunks that predate duration scraping. */}
                {durationLabel && (
                    <span
                        className="absolute bottom-2 right-2 rounded bg-black px-1.5 py-0.5 text-[13px] font-semibold leading-tight text-white tabular-nums"
                        aria-label={`Duration: ${durationLabel}`}
                    >
                        {durationLabel}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2 px-3 py-2.5">
                {loading ? (
                    <span className="block h-4 w-3/4 animate-pulse rounded bg-gray-200" aria-hidden="true" />
                ) : (
                    <span className="line-clamp-2 text-sm font-medium text-gray-900">{displayTitle}</span>
                )}
            </div>
        </a>
    );
};

const DownloadCard = ({ url, name }) => {
    const displayName = (typeof name === 'string' && name.trim()) || 'download';
    const ext = displayName.includes('.') ? displayName.split('.').pop().toUpperCase() : 'FILE';

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            // ``download`` is a hint only — cross-origin servers ignore it,
            // so the browser falls back to native handling (open PDF in a
            // tab, prompt for save on unknown types). Either behaviour is
            // acceptable; we just want the click to work everywhere.
            download={displayName}
            className="oyechats-media-card oyechats-media-card--download mt-2 flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1"
            aria-label={`Download ${displayName}`}
        >
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <FileDown className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-gray-900">{displayName}</span>
                <span className="text-xs uppercase tracking-wide text-gray-500">{ext} · Download</span>
            </span>
        </a>
    );
};

const MediaCard = ({ card }) => {
    if (!card || typeof card !== 'object') return null;
    if (card.type === 'youtube' && typeof card.video_id === 'string' && card.video_id) {
        return (
            <YouTubeCard
                videoId={card.video_id}
                durationSeconds={card.duration_seconds}
                title={card.title}
            />
        );
    }
    if (card.type === 'download' && typeof card.url === 'string' && card.url) {
        return <DownloadCard url={card.url} name={card.name} />;
    }
    // Unknown card type — silently render nothing so a future backend
    // addition doesn't break existing widget bundles in the wild.
    return null;
};

export default MediaCard;
