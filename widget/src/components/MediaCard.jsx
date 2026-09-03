import React, { useEffect, useState } from 'react';
import { FileText, Play } from 'lucide-react';
import { t } from '../i18n/i18n.js';
import { sanitizeFileUrl } from '../services/sanitize.js';

/**
 * MediaCard. Inline chat card for a single YouTube video OR a downloadable
 * file. Rendered by MessageBubble beneath the bot's text when a message
 * carries a ``media_card`` property, which the backend injects into
 * FINAL_METADATA whenever the LLM emits ``[YOUTUBE_CARD:VIDEO_ID]`` or
 * ``[DOWNLOAD_CARD:URL|FILENAME]``. See ``_extract_media_card`` in
 * ``platform/api/app/services/rag_service.py``.
 *
 * Minimal treatment (per product decision):
 *   - YouTube: thumbnail + video title + click-to-watch.
 *   - Download: file icon + filename + download button.
 * No channel name, no duration, no date. Kept intentionally spare so the
 * card reads as an accent to the answer, not a takeover.
 *
 * Props:
 *   card: { type: 'youtube', video_id: string }
 *       | { type: 'download', url: string, name: string }
 */

// Cross-instance in-memory cache of resolved YouTube titles. Keyed by
// video_id so the same video only ever costs one oEmbed roundtrip in the
// lifetime of the widget script. Never hits localStorage, the widget runs
// in the customer's page and we don't want to reserve storage there.
const _ytTitleCache = new Map();

// oEmbed endpoint. Free, keyless, CORS-enabled. Returns title, author_name,
// thumbnail_url, and a few others; we only read title. Failures fall back to
// a generic label so the card never blocks the answer.
const YT_OEMBED_URL = 'https://www.youtube.com/oembed';

// Format a video length (integer seconds) as ``M:SS``, or ``H:MM:SS`` for
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
    // FINAL_METADATA) always wins over the client-side oEmbed lookup.
    // It's already ready by the time the card mounts, so the title
    // renders in the same frame as the thumbnail instead of flickering
    // in a beat later. Prime the cache too so a subsequent re-render or
    // another card for the same video skips oEmbed entirely.
    const _serverTitle = typeof initialTitle === 'string' ? initialTitle.trim() : '';
    if (_serverTitle && !_ytTitleCache.has(videoId)) {
        _ytTitleCache.set(videoId, _serverTitle);
    }
    // React's official "reset state when a prop changes" pattern. Track the
    // last ``videoId`` we rendered for, and if the incoming prop differs,
    // re-derive state during render. That keeps the state up-to-date on
    // prop change without calling setState in an effect (which React 19's
    // ``react-hooks/set-state-in-effect`` rule flags as a smell. Cascading
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
        // Cache hit, the state above is already correct; no fetch needed.
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
                // Cache the empty result too, no point re-fetching a video
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
    const displayTitle = loading ? '' : title || t('media.watch_on_youtube') || 'Watch on YouTube';

    return (
        <a
            href={watchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="oyechats-media-card oyechats-media-card--youtube flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1"
            aria-label={
                loading
                    ? (t('media.loading_video_aria') || 'Loading YouTube video')
                    : (t('media.watch_youtube_aria', { title: displayTitle })
                        || `Watch on YouTube: ${displayTitle}`)
            }
        >
            <div className="relative aspect-video w-full bg-gray-100">
                <img
                    src={thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={(e) => {
                        // Fall back to the medium-quality still if hqdefault
                        // 404s (very rare. Usually region blocks or takedowns).
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
                {/* Duration pill. Bottom-right corner of the thumbnail,
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

// File-type presentation table. Each entry maps an uppercased extension to
// the tint used for the icon badge and the short label shown in the meta row.
// Anything not listed falls back to ``_DEFAULT_FILE_META`` (a neutral slate
// badge labelled with the raw extension) so the card degrades gracefully for
// file types we haven't styled explicitly.
const _FILE_META = {
    PDF: { tint: '#E4483D', label: 'PDF' },
    DOC: { tint: '#2B6FD6', label: 'DOC' },
    DOCX: { tint: '#2B6FD6', label: 'DOC' },
    XLS: { tint: '#1E9E58', label: 'XLS' },
    XLSX: { tint: '#1E9E58', label: 'XLS' },
    CSV: { tint: '#1E9E58', label: 'CSV' },
    PPT: { tint: '#D2542C', label: 'PPT' },
    PPTX: { tint: '#D2542C', label: 'PPT' },
    ZIP: { tint: '#8A7CE0', label: 'ZIP' },
    RAR: { tint: '#8A7CE0', label: 'RAR' },
    PNG: { tint: '#6366F1', label: 'PNG' },
    JPG: { tint: '#6366F1', label: 'JPG' },
    JPEG: { tint: '#6366F1', label: 'JPG' },
    GIF: { tint: '#6366F1', label: 'GIF' },
    WEBP: { tint: '#6366F1', label: 'WEBP' },
    SVG: { tint: '#6366F1', label: 'SVG' },
    TXT: { tint: '#64748B', label: 'TXT' },
    MD: { tint: '#64748B', label: 'MD' },
};
const _DEFAULT_FILE_META = { tint: '#64748B', label: 'FILE' };

// Extensions the browser can render inline (open in a new tab) rather than
// force-download. Drives the action verb ("View" vs "Download") and whether we
// set the ``download`` attribute. We only hint a save for non-viewable types.
const _OPENABLE_EXTS = new Set([
    'PDF', 'PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'TXT', 'MD',
]);

// Cross-instance cache of resolved file sizes, keyed by URL. Stores the
// formatted label (e.g. "1.5 MB") on success, or ``null`` when the size can't
// be determined, so a file whose host blocks the HEAD probe is asked about
// only once per widget lifetime, not on every re-render. Never touches
// localStorage; the widget runs on the customer's page.
const _fileSizeCache = new Map();

// Format a byte count as a compact human label ("512 B", "1.5 MB"). Bytes and
// KB read as whole numbers; MB and up keep one decimal so "1.5 MB" doesn't
// collapse to "2 MB". Returns ``null`` for anything unusable so the caller can
// omit the chip rather than render "NaN".
const _formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const rounded = unit <= 1 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded} ${units[unit]}`;
};

// Adobe-style document glyph: a white sheet with a folded top-right corner and
// the file-type label across the body, sitting on the tinted badge. Purely
// decorative, the surrounding anchor carries the accessible label.
const _FileGlyph = ({ tint, label }) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
            d="M7 2.75h6.19L19 8.56V19a2.25 2.25 0 0 1-2.25 2.25h-9.5A2.25 2.25 0 0 1 5 19V5A2.25 2.25 0 0 1 7 2.75Z"
            fill="#fff"
        />
        <path d="M13 2.9v4.4A1.3 1.3 0 0 0 14.3 8.6h4.4L13 2.9Z" fill="rgba(0,0,0,0.16)" />
        <text
            x="11.6"
            y="17.2"
            textAnchor="middle"
            fontSize="4.9"
            fontWeight="700"
            letterSpacing="-0.2"
            fill={tint}
            style={{ fontFamily: 'inherit' }}
        >
            {label}
        </text>
    </svg>
);

const DownloadCard = ({ url, name }) => {
    const rawName = (typeof name === 'string' && name.trim()) || 'download';
    const dotIndex = rawName.lastIndexOf('.');
    const ext = dotIndex > 0 ? rawName.slice(dotIndex + 1).toUpperCase() : '';
    const { tint, label } = _FILE_META[ext] || (ext ? { ..._DEFAULT_FILE_META, label: ext } : _DEFAULT_FILE_META);
    const openable = _OPENABLE_EXTS.has(ext);
    // The visible pill label AND the aria sentence below are built from this,
    // so it has to be the localized word, not an English key.
    const action = openable
        ? (t('media.action_view') || 'View')
        : (t('media.action_download') || 'Download');

    // File size is not in the card payload (the backend only stores url + name),
    // so we probe it client-side with a HEAD request and read Content-Length.
    // It's a progressive enhancement: when the host blocks HEAD, hides the
    // header via CORS, or omits Content-Length, ``sizeLabel`` stays null and the
    // size chip is simply not rendered. React's "reset state on prop change"
    // pattern (mirroring YouTubeCard) keeps the label correct if the same card
    // instance is reused for a different URL.
    const [renderedUrl, setRenderedUrl] = useState(url);
    const [sizeLabel, setSizeLabel] = useState(() => _fileSizeCache.get(url) ?? null);

    if (renderedUrl !== url) {
        setRenderedUrl(url);
        setSizeLabel(_fileSizeCache.get(url) ?? null);
    }

    useEffect(() => {
        // Cache hit (success or a cached "unknown"), no probe needed.
        if (_fileSizeCache.has(url)) return undefined;
        let cancelled = false;
        const controller = new AbortController();
        fetch(url, { method: 'HEAD', signal: controller.signal })
            .then((res) => {
                if (!res.ok) return null;
                const len = res.headers.get('content-length');
                return len ? _formatBytes(Number(len)) : null;
            })
            .then((resolved) => {
                if (cancelled) return;
                _fileSizeCache.set(url, resolved);
                setSizeLabel(resolved);
            })
            .catch(() => {
                if (cancelled) return;
                // Cache the miss too so we don't re-probe a host that blocks us.
                _fileSizeCache.set(url, null);
                setSizeLabel(null);
            });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [url]);

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            // ``download`` is a hint only. Cross-origin servers ignore it, so
            // the browser falls back to native handling. We only set it for
            // non-viewable types; viewable ones (PDF, images) open in a tab.
            download={openable ? undefined : rawName}
            className="oyechats-media-card oyechats-media-card--download group flex max-w-full items-center gap-2 rounded-xl border border-gray-200 bg-white p-1.5 pl-2 pr-2 shadow-sm transition-all hover:border-gray-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-1"
            aria-label={
                sizeLabel
                    ? (t('media.file_aria_sized', { action, name: rawName, size: sizeLabel })
                        || `${action} ${rawName}, ${sizeLabel}`)
                    : (t('media.file_aria', { action, name: rawName })
                        || `${action} ${rawName}`)
            }
        >
            <span
                className="flex h-8 w-8 flex-none items-center justify-center rounded-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                style={{ backgroundColor: tint }}
            >
                <_FileGlyph tint={tint} label={label} />
            </span>
            {/* Title wraps to two lines so long, hyphenated filenames stay
                readable. ``line-clamp-2`` keeps the card height bounded and
                ``break-all`` lets the browser wrap mid-hyphen when the
                filename contains no whitespace (common: kebab-case slugs).
                Size drops to a small caption below the title so the title
                gets both lines to itself; it renders only when the HEAD
                probe surfaced a Content-Length. */}
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="line-clamp-2 break-all text-sm font-semibold text-gray-900">{rawName}</span>
                {sizeLabel && <span className="mt-0.5 text-[11px] text-gray-400">{sizeLabel}</span>}
            </span>
            <span className="flex-none rounded-md bg-blue-50 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-600 transition-colors group-hover:bg-blue-100">
                {action}
            </span>
        </a>
    );
};

// Compact secondary chip, one small row per related asset, rendered under
// the primary card. Purely an opt-in pointer ("here's a related file/video
// if you want it"); intentionally quiet so it never competes with the
// primary card for attention. Same visual weight as a caption. Kept
// self-contained so it renders without pulling in the full DownloadCard /
// YouTubeCard layouts.
const _SecondaryChip = ({ item }) => {
    if (!item || typeof item !== 'object') return null;
    if (item.type === 'youtube' && typeof item.video_id === 'string' && item.video_id) {
        // A server-supplied watch URL is honoured only when it is an absolute
        // http(s) URL; anything else falls back to the canonical YouTube link
        // built from the video id, which is always safe.
        const href = (typeof item.url === 'string' && sanitizeFileUrl(item.url))
            || `https://www.youtube.com/watch?v=${encodeURIComponent(item.video_id)}`;
        const label = (typeof item.title === 'string' && item.title.trim())
            || t('media.related_video') || 'Related video';
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="oyechats-media-secondary group mt-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-800"
                aria-label={t('media.related_video_aria', { label }) || `Related video: ${label}`}
            >
                <span className="flex h-4 w-4 flex-none items-center justify-center rounded-sm bg-red-600 text-[8px] font-bold uppercase leading-none text-white">▶</span>
                <span className="truncate">
                    {t('media.also_available') || 'Also available:'} <span className="font-medium text-gray-700 group-hover:text-gray-900">{label}</span>
                </span>
            </a>
        );
    }
    if (item.type === 'download' && typeof item.url === 'string' && item.url) {
        const href = sanitizeFileUrl(item.url);
        if (!href) return null;
        const label = (typeof item.name === 'string' && item.name.trim())
            || t('media.related_file') || 'Related file';
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="oyechats-media-secondary group mt-1.5 inline-flex max-w-full items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-800"
                aria-label={t('media.related_file_aria', { label }) || `Related file: ${label}`}
            >
                <span className="flex h-4 w-4 flex-none items-center justify-center rounded-sm bg-gray-800 text-[8px] font-bold uppercase leading-none text-white">
                    PDF
                </span>
                <span className="truncate">
                    {t('media.also_available') || 'Also available:'} <span className="font-medium text-gray-700 group-hover:text-gray-900">{label}</span>
                </span>
            </a>
        );
    }
    return null;
};

// Small overline hint sitting above the media card. Names the medium the
// visitor is about to interact with ("watch the video" / "open the document")
// so the card never lands without a cue, a deterministic fallback for the
// LLM's bridge sentence, which is mandated in the system prompt but not 100%
// reliable in practice. Intentionally muted (11px, gray-500, subtle icon) so
// on well-bridged answers it reads as a card label rather than a duplicate
// sentence competing with the prose above.
const _MediaHint = ({ card }) => {
    if (!card || typeof card !== 'object') return null;
    if (card.type === 'youtube') {
        return (
            <div
                className="oyechats-media-hint mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-gray-500"
                aria-hidden="true"
            >
                <Play className="h-3 w-3 fill-current text-red-500" strokeWidth={0} />
                <span>{t('media.watch_video') || 'Watch the video for the full picture'}</span>
            </div>
        );
    }
    if (card.type === 'download') {
        const rawName = typeof card.name === 'string' ? card.name : '';
        const dotIndex = rawName.lastIndexOf('.');
        const ext = dotIndex > 0 ? rawName.slice(dotIndex + 1).toUpperCase() : '';
        const openable = _OPENABLE_EXTS.has(ext);
        const label = openable
            ? (t('media.open_document_hint') || 'Open the document to learn more')
            : (t('media.download_file_hint') || 'Download the file to learn more');
        return (
            <div
                className="oyechats-media-hint mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-gray-500"
                aria-hidden="true"
            >
                <FileText className="h-3 w-3 text-gray-400" strokeWidth={2} />
                <span>{label}</span>
            </div>
        );
    }
    return null;
};

const MediaCard = ({ card, secondary }) => {
    if (!card || typeof card !== 'object') return null;
    let primary = null;
    if (card.type === 'youtube' && typeof card.video_id === 'string' && card.video_id) {
        primary = (
            <YouTubeCard
                videoId={card.video_id}
                durationSeconds={card.duration_seconds}
                title={card.title}
            />
        );
    } else if (card.type === 'download' && typeof card.url === 'string' && card.url) {
        // The server whitelists download URLs against the chunk metadata, but
        // the client must not depend on that single check: anything that is not
        // an absolute http(s) URL (javascript:, data:, a protocol-relative
        // host) never reaches an ``href`` here.
        const href = sanitizeFileUrl(card.url);
        if (href) primary = <DownloadCard url={href} name={card.name} />;
    }
    if (!primary) {
        // Unknown card type. Silently render nothing so a future backend
        // addition doesn't break existing widget bundles in the wild.
        return null;
    }
    // ``secondary`` is a list (0 or 1 element today) shaped like the primary
    // ``card`` payload. See ``_pick_secondary_media`` in rag_service.py.
    // Keeping it as a list means the server can later relax the one-chip cap
    // without another metadata migration on the wire.
    const chips = Array.isArray(secondary) ? secondary.filter(Boolean) : [];
    return (
        <div className="oyechats-media-block mt-2 flex flex-col">
            <_MediaHint card={card} />
            {primary}
            {chips.map((item, i) => (
                <_SecondaryChip
                    key={
                        item.type === 'youtube'
                            ? `yt:${item.video_id}`
                            : item.type === 'download'
                                ? `dl:${item.url}`
                                : `x:${i}`
                    }
                    item={item}
                />
            ))}
        </div>
    );
};

export default MediaCard;
