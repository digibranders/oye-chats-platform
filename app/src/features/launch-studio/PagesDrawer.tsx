import { useEffect } from 'react';
import { X, ExternalLink, Globe } from 'lucide-react';
import type { SourcePage } from '../../types/domain';

function toPath(url: string): string {
  try {
    return new URL(url).pathname || url;
  } catch {
    return url;
  }
}

export interface PagesDrawerProps {
  source: string;
  pages: SourcePage[];
  onClose: () => void;
}

/**
 * PagesDrawer - a right slide-over listing ALL crawled pages for a source
 * (fresh TS on the new DS; mirrors the legacy SourcePagesDrawer content).
 */
export function PagesDrawer({ source, pages, onClose }: PagesDrawerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Pages for ${source}`}>
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--ds-border)] p-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
              <Globe size={16} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-[var(--ds-text)]">{source}</p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">
                {pages.length} page{pages.length === 1 ? '' : 's'} trained
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]"
          >
            <X size={16} />
          </button>
        </header>

        <ul className="min-h-0 flex-1 divide-y divide-[var(--ds-border)] overflow-y-auto">
          {pages.map((page, idx) => (
            <li
              key={`${page.url}-${idx}`}
              className="group grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <span className="block truncate font-mono text-[12px] leading-snug text-[var(--ds-accent-text)]">
                  {toPath(page.url)}
                </span>
                {page.title && (
                  <span className="mt-0.5 block truncate text-[11px] leading-snug text-[var(--ds-text-subtle)]">
                    {page.title}
                  </span>
                )}
              </div>
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${page.url}`}
                className="rounded p-1 text-[var(--ds-text-subtle)] opacity-0 transition-opacity hover:text-[var(--ds-accent-text)] group-hover:opacity-100"
              >
                <ExternalLink size={13} />
              </a>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
