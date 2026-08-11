import { type ReactElement, useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  House,
  Minus,
} from 'lucide-react';
import { cn } from '../../../design-system';

/**
 * A node in the discovered-page route tree. A node can be a folder (has
 * ``children``), a page (has a ``url``), or both (e.g. ``/blog`` is a real page
 * that also has ``/blog/post-1`` beneath it). ``urls`` is the flattened set of
 * every page URL in this subtree — including this node's own — precomputed so
 * selection maths (checked / indeterminate / toggle-all) stay O(1) per node.
 */
interface PageNode {
  /** Path key, e.g. ``/``, ``/blog``, ``/blog/post-1?ref=x``. Unique per node. */
  id: string;
  /** Display label for this level (the last path segment, or the host at root). */
  segment: string;
  /** The real page URL when this node is itself a crawlable page. */
  url: string | null;
  children: PageNode[];
  /** Every page URL in this subtree, including ``url``. Computed after build. */
  urls: string[];
}

export interface CrawlPageTreeProps {
  /** All discovered page URLs (from ``/crawl/discover``). */
  urls: readonly string[];
  /** Controlled set of currently-selected page URLs. */
  selected: readonly string[];
  /** Called with the next full selection whenever the user toggles a node. */
  onSelectionChange: (next: string[]) => void;
  /** Disables all interaction (e.g. while a crawl is starting). */
  disabled?: boolean;
}

/** Host label shown at the tree root, derived from the first parseable URL. */
function rootHost(urls: readonly string[]): string {
  for (const raw of urls) {
    try {
      return new URL(raw).host.replace(/^www\./, '');
    } catch {
      continue;
    }
  }
  return 'Website';
}

/**
 * Build a route tree from a flat URL list. URLs are grouped by their path
 * segments; the last segment carries any query string so two pages that differ
 * only by ``?query`` remain distinct, selectable leaves rather than colliding.
 */
function buildTree(urls: readonly string[]): PageNode {
  const host = rootHost(urls);
  const root: PageNode = { id: '/', segment: host, url: null, children: [], urls: [] };
  const byPath = new Map<string, PageNode>([['/', root]]);

  for (const raw of urls) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const search = parsed.search || '';
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Homepage ("/" or "/?query"): attach to the root, or hang a labelled leaf
    // when a query string makes it distinct from the bare homepage.
    if (segments.length === 0) {
      if (search) {
        const id = `/${search}`;
        let node = byPath.get(id);
        if (!node) {
          node = { id, segment: search, url: raw, children: [], urls: [] };
          byPath.set(id, node);
          root.children.push(node);
        } else {
          node.url = raw;
        }
      } else {
        root.url = raw;
      }
      continue;
    }

    let parent = root;
    let acc = '';
    segments.forEach((seg, i) => {
      const isLast = i === segments.length - 1;
      const label = decodeURIComponent(seg) + (isLast ? search : '');
      acc += `/${seg}${isLast ? search : ''}`;
      let node = byPath.get(acc);
      if (!node) {
        node = { id: acc, segment: label, url: null, children: [], urls: [] };
        byPath.set(acc, node);
        parent.children.push(node);
      }
      if (isLast) node.url = raw;
      parent = node;
    });
  }

  // Bottom-up: flatten subtree URLs and sort (folders before leaves, then alpha).
  const finalize = (node: PageNode): string[] => {
    node.children.sort((a, b) => {
      const aFolder = a.children.length > 0 ? 0 : 1;
      const bFolder = b.children.length > 0 ? 0 : 1;
      if (aFolder !== bFolder) return aFolder - bFolder;
      return a.segment.localeCompare(b.segment);
    });
    const collected = node.url ? [node.url] : [];
    for (const child of node.children) collected.push(...finalize(child));
    node.urls = collected;
    return collected;
  };
  finalize(root);
  return root;
}

type CheckState = 'checked' | 'indeterminate' | 'unchecked';

function checkState(node: PageNode, selected: Set<string>): CheckState {
  let hit = 0;
  for (const u of node.urls) if (selected.has(u)) hit += 1;
  if (hit === 0) return 'unchecked';
  if (hit === node.urls.length) return 'checked';
  return 'indeterminate';
}

/** A three-state checkbox rendered as a styled button box. */
function CheckBox({ state }: { state: CheckState }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        state === 'unchecked'
          ? 'border-[var(--ds-border-strong)] bg-[var(--ds-bg-surface)]'
          : 'border-[var(--ds-accent)] bg-[var(--ds-accent)] text-white',
      )}
    >
      {state === 'checked' && <Check size={12} strokeWidth={3} />}
      {state === 'indeterminate' && <Minus size={12} strokeWidth={3} />}
    </span>
  );
}

interface TreeRowProps {
  node: PageNode;
  depth: number;
  selected: Set<string>;
  expanded: Set<string>;
  disabled: boolean;
  onToggleSelect: (node: PageNode) => void;
  onToggleExpand: (id: string) => void;
}

function TreeRow({
  node,
  depth,
  selected,
  expanded,
  disabled,
  onToggleSelect,
  onToggleExpand,
}: TreeRowProps): ReactElement {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.id);
  const state = checkState(node, selected);
  const pageCount = node.urls.length;

  const RowIcon = hasChildren ? (isOpen ? FolderOpen : Folder) : FileIcon;
  const rowLabel = depth === 0 ? node.segment : node.segment || '/';

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined} aria-selected={state === 'checked'}>
      <div
        className="flex items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-[var(--ds-bg-sunken)]"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.id)}
            aria-label={isOpen ? `Collapse ${rowLabel}` : `Expand ${rowLabel}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ds-text-subtle)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform', isOpen && 'rotate-90')}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}

        <button
          type="button"
          disabled={disabled}
          onClick={() => onToggleSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] rounded disabled:cursor-not-allowed"
        >
          <CheckBox state={state} />
          {depth === 0 ? (
            <House size={14} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          ) : (
            <RowIcon size={14} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          )}
          <span className="truncate text-[13px] text-[var(--ds-text)]">{rowLabel}</span>
          {hasChildren && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-text-subtle)]">
              {pageCount}
            </span>
          )}
        </button>
      </div>

      {hasChildren && isOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              disabled={disabled}
              onToggleSelect={onToggleSelect}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * CrawlPageTree — an interactive route tree of every page discovered on a site,
 * letting the customer choose exactly which pages to train the AI on before the
 * crawl runs. Folders aggregate their descendants with a tri-state checkbox and
 * toggle all pages beneath them at once; the selection is reported upward as a
 * flat URL list ready to pass as ``ordered_urls`` to the crawl endpoint.
 */
export function CrawlPageTree({
  urls,
  selected,
  onSelectionChange,
  disabled = false,
}: CrawlPageTreeProps): ReactElement {
  const tree = useMemo(() => buildTree(urls), [urls]);
  const allUrls = tree.urls;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Default-expand only the top level so large sites open scannable, not as a
  // wall of every nested page. Users drill in (or Expand all) from there.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const top = new Set<string>();
    top.add(tree.id);
    for (const child of tree.children) if (child.children.length > 0) top.add(child.id);
    return top;
  });

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelect = (node: PageNode): void => {
    const state = checkState(node, selectedSet);
    const next = new Set(selectedSet);
    if (state === 'checked') {
      for (const u of node.urls) next.delete(u);
    } else {
      for (const u of node.urls) next.add(u);
    }
    onSelectionChange(allUrls.filter((u) => next.has(u)));
  };

  const setAllExpanded = (open: boolean): void => {
    if (!open) {
      setExpanded(new Set());
      return;
    }
    const ids = new Set<string>();
    const walk = (node: PageNode): void => {
      if (node.children.length > 0) {
        ids.add(node.id);
        node.children.forEach(walk);
      }
    };
    walk(tree);
    setExpanded(ids);
  };

  const selectedCount = selectedSet.size;
  const allSelected = selectedCount === allUrls.length && allUrls.length > 0;

  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
      {/* Toolbar: select-all + count + expand controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ds-border)] px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelectionChange(allSelected ? [] : [...allUrls])}
            className="flex items-center gap-2 rounded text-[13px] font-medium text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] disabled:cursor-not-allowed"
          >
            <CheckBox
              state={allSelected ? 'checked' : selectedCount > 0 ? 'indeterminate' : 'unchecked'}
            />
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
          <span className="text-[12px] text-[var(--ds-text-muted)]">
            <span className="font-semibold tabular-nums text-[var(--ds-text)]">{selectedCount}</span>
            {' of '}
            <span className="tabular-nums">{allUrls.length}</span> selected
          </span>
        </div>
        <div className="flex items-center gap-1 text-[12px]">
          <button
            type="button"
            onClick={() => setAllExpanded(true)}
            className="rounded px-1.5 py-0.5 text-[var(--ds-text-muted)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          >
            Expand all
          </button>
          <span className="text-[var(--ds-border-strong)]">·</span>
          <button
            type="button"
            onClick={() => setAllExpanded(false)}
            className="rounded px-1.5 py-0.5 text-[var(--ds-text-muted)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          >
            Collapse all
          </button>
        </div>
      </div>

      {/* The tree itself */}
      <div className="max-h-72 overflow-y-auto py-1.5 pr-1">
        <ul role="tree" aria-label="Discovered pages">
          <TreeRow
            node={tree}
            depth={0}
            selected={selectedSet}
            expanded={expanded}
            disabled={disabled}
            onToggleSelect={toggleSelect}
            onToggleExpand={toggleExpand}
          />
        </ul>
      </div>
    </div>
  );
}
