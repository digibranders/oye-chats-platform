import { useMemo, useState } from 'react';
import { ChevronRight, File as FileIcon, Folder, FolderOpen, Globe, Maximize2 } from 'lucide-react';
import { Button, Checkbox, Dialog, cn, formatNumber } from '../../../ui';
// A pure helper, not a component, so the module-level resolver rather than the hook.
import { t as translateNow } from '../../../i18n/i18n';

/**
 * A node in the discovered-page route tree.
 *
 * A node can be a folder (has `children`), a page (has a `url`), or both —
 * `/blog` is usually a real page that also has `/blog/post-1` beneath it.
 * `urls` is the flattened set of every page in the subtree, precomputed once so
 * the selection maths (checked / indeterminate / toggle-all) stays O(1) a node.
 */
interface PageNode {
  id: string;
  segment: string;
  url: string | null;
  children: PageNode[];
  urls: string[];
}

/**
 * `decodeURIComponent` that cannot take the panel down.
 *
 * It throws `URIError` on a lone `%` or a truncated escape, and real sitemaps
 * contain both — `/sale/50%_off` survives `new URL()` intact and then throws
 * here. Unguarded, one such URL unmounted the whole add-knowledge panel to the
 * error boundary and left the customer unable to add their website at all. A
 * slightly uglier label beats no panel.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function rootHost(urls: readonly string[]): string {
  for (const raw of urls) {
    try {
      return new URL(raw).host.replace(/^www\./, '');
    } catch {
      continue;
    }
  }
  return translateNow('agents.website') || 'Website';
}

/**
 * Build a route tree from a flat URL list.
 *
 * The last segment carries any query string, so two pages that differ only by
 * `?variant=` stay distinct, selectable leaves rather than collapsing into one.
 */
function buildTree(urls: readonly string[]): PageNode {
  const root: PageNode = { id: '/', segment: rootHost(urls), url: null, children: [], urls: [] };
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

    if (segments.length === 0) {
      if (!search) {
        root.url = raw;
        continue;
      }
      const id = `/${search}`;
      const existing = byPath.get(id);
      if (existing) {
        existing.url = raw;
      } else {
        const node: PageNode = { id, segment: search, url: raw, children: [], urls: [] };
        byPath.set(id, node);
        root.children.push(node);
      }
      continue;
    }

    let parent = root;
    let path = '';
    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;
      path += `/${segment}${isLast ? search : ''}`;
      let node = byPath.get(path);
      if (!node) {
        node = {
          id: path,
          segment: safeDecode(segment) + (isLast ? search : ''),
          url: null,
          children: [],
          urls: [],
        };
        byPath.set(path, node);
        parent.children.push(node);
      }
      if (isLast) node.url = raw;
      parent = node;
    });
  }

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

/**
 * The discovered URLs, deduplicated exactly as the tree deduplicates them, in
 * **discovery order**.
 *
 * That order is load-bearing. This list is submitted as `ordered_urls`, and the
 * backend truncates it to what the plan and the credit balance allow, then
 * deducts per page in order. The tree sorts folders before leaves and then
 * alphabetically, which is right for reading and wrong for buying: on a site
 * whose budget covers a fraction of its pages, a `/blog` subtree would sort
 * ahead of `/about` and `/pricing` and eat the whole allowance, leaving a
 * chatbot that cannot answer a pricing question. Discovery order puts the seed
 * URL first and follows the site's own sitemap priority.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function canonicalCrawlUrls(urls: readonly string[]): string[] {
  const canonical = new Set(buildTree(urls).urls);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const url of urls) {
    if (!canonical.has(url) || seen.has(url)) continue;
    seen.add(url);
    ordered.push(url);
  }
  return ordered;
}

/** One level of nesting, on the 4-base scale. */
const INDENT_PX = 16;

type CheckState = true | false | 'indeterminate';

function checkState(node: PageNode, selected: ReadonlySet<string>): CheckState {
  let hit = 0;
  for (const url of node.urls) if (selected.has(url)) hit += 1;
  if (hit === 0) return false;
  return hit === node.urls.length ? true : 'indeterminate';
}

interface RowProps {
  node: PageNode;
  depth: number;
  selected: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
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
}: RowProps) {
  const hasChildren = node.children.length > 0;
  const open = expanded.has(node.id);
  const state = checkState(node, selected);
  const label = depth === 0 ? node.segment : node.segment || '/';
  const RowIcon = depth === 0 ? Globe : hasChildren ? (open ? FolderOpen : Folder) : FileIcon;
  const groupId = `${node.id}-children`;

  return (
    <li>
      {/* The row is 36px regardless — `py-1` around a 28px control or the 28px
          spacer below — so the SC 2.5.8 target floor is met by the spacer's own
          height rather than by a `min-h` the layout always exceeded. The indent
          is computed from a depth, which genuinely cannot be a utility class;
          the step is a named constant so it stays on the 4-base scale. */}
      <div
        className="flex items-center gap-1.5 rounded-sm py-1 pr-2 hover:bg-surface-hover"
        style={{ paddingLeft: `${depth * INDENT_PX + 4}px` }}
      >
        {hasChildren ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={groupId}
            aria-label={`${open ? translateNow('agents.collapse') || 'Collapse' : translateNow('agents.expand') || 'Expand'} ${label}`}
            onClick={() => onToggleExpand(node.id)}
          >
            <ChevronRight
              aria-hidden
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
            />
          </Button>
        ) : (
          // 28px, which is what actually sets the row's minimum target.
          <span aria-hidden className="h-control-sm w-control-sm" />
        )}
        <Checkbox
          checked={state}
          disabled={disabled}
          onCheckedChange={() => onToggleSelect(node)}
          aria-label={
            hasChildren
              ? `${label} and everything under it, ${node.urls.length} pages`
              : `${label}`
          }
        />
        <RowIcon aria-hidden className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
        <span className="truncate text-sm text-text-primary">{label}</span>
        {hasChildren ? (
          <span className="figure shrink-0 text-2xs text-text-tertiary">{node.urls.length}</span>
        ) : null}
      </div>

      {hasChildren && open ? (
        <ul id={groupId}>
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
      ) : null}
    </li>
  );
}

export interface CrawlPageTreeProps {
  urls: readonly string[];
  selected: readonly string[];
  onSelectionChange: (next: string[]) => void;
  disabled?: boolean;
}

/**
 * Which pages of a discovered site to train on, before a single credit is spent.
 *
 * Nested lists of real checkboxes and real disclosure buttons rather than
 * `role="tree"`. A tree widget owes its user the full APG keyboard contract —
 * arrow navigation, type-ahead, Home/End, a roving tabindex — and the version
 * this replaces claimed `role="tree"` while shipping none of it, which is worse
 * for a screen-reader user than the grouped checkboxes it actually was: the role
 * promised keys that did nothing. Here every control is in the tab order and
 * behaves exactly as it announces.
 */
export function CrawlPageTree({
  urls,
  selected,
  onSelectionChange,
  disabled = false,
}: CrawlPageTreeProps) {
  const tree = useMemo(() => buildTree(urls), [urls]);
  // Discovery order, not tree order. Everything this component emits is
  // submitted as `ordered_urls` and billed in the order it is sent, so the
  // alphabetical, folders-first order the tree reads best in would spend a
  // small site's whole budget on `/blog` before it reached `/pricing`.
  const allUrls = useMemo(() => canonicalCrawlUrls(urls), [urls]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [maximized, setMaximized] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Only the top level opens by default: a 400-page site rendered fully
    // expanded is a wall, and the customer's first job is to scan the sections.
    const open = new Set<string>([tree.id]);
    for (const child of tree.children) if (child.children.length > 0) open.add(child.id);
    return open;
  });

  function toggleExpand(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelect(node: PageNode) {
    const next = new Set(selectedSet);
    if (checkState(node, selectedSet) === true) {
      for (const url of node.urls) next.delete(url);
    } else {
      for (const url of node.urls) next.add(url);
    }
    // Re-derived from `allUrls` so the emitted order stays discovery order.
    onSelectionChange(allUrls.filter((url) => next.has(url)));
  }

  function setAllExpanded(open: boolean) {
    if (!open) {
      setExpanded(new Set());
      return;
    }
    const ids = new Set<string>();
    const walk = (node: PageNode) => {
      if (node.children.length === 0) return;
      ids.add(node.id);
      node.children.forEach(walk);
    };
    walk(tree);
    setExpanded(ids);
  }

  // Counted as the intersection with the tree, never `selectedSet.size`. The
  // caller seeds the selection from the raw discovery result, which can hold
  // near-duplicates the tree collapses into one node — so the raw set can be
  // larger than the tree, and the header would read the impossible "18 of 17".
  const selectedCount = useMemo(
    () => allUrls.reduce((count, url) => (selectedSet.has(url) ? count + 1 : count), 0),
    [allUrls, selectedSet],
  );
  const allSelected = allUrls.length > 0 && selectedCount === allUrls.length;

  /** Whether "expand all" would still do anything, so one button can be both. */
  const anyCollapsed = useMemo(() => {
    const walk = (node: PageNode): boolean =>
      node.children.length > 0 &&
      (!expanded.has(node.id) || node.children.some(walk));
    return walk(tree);
  }, [tree, expanded]);

  const body = (maxHeight: string, showMaximize: boolean) => (
    <div className="rounded-md border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 py-2">
        <div className="flex items-center gap-2.5">
          <Checkbox
            checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
            disabled={disabled}
            onCheckedChange={() => onSelectionChange(allSelected ? [] : [...allUrls])}
            aria-label={allSelected ? translateNow('agents.clearEveryPage') || 'Clear every page' : translateNow('agents.selectEveryPage') || 'Select every page'}
          />
          <span className="text-xs text-text-secondary">
            <span className="figure font-medium text-text-primary">
              {formatNumber(selectedCount)}
            </span>{' '}
            of <span className="figure">{formatNumber(allUrls.length)}</span> pages selected
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* One control with two states, not two controls one of which is
              always a no-op. */}
          <Button size="sm" variant="ghost" onClick={() => setAllExpanded(!anyCollapsed)}>
            {anyCollapsed ? translateNow('agents.expandAll') || 'Expand all' : translateNow('agents.collapseAll') || 'Collapse all'}
          </Button>
          {showMaximize ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMaximized(true)}
              iconLeft={<Maximize2 aria-hidden className="h-3.5 w-3.5" />}
            >
              {translateNow('agents.expandView') || 'Expand view'}
            </Button>
          ) : null}
        </div>
      </div>
      <div className={cn('overflow-y-auto py-1.5 pr-1', maxHeight)}>
        <ul aria-label={translateNow('agents.pagesFoundOnThisWebsite') || 'Pages found on this website'}>
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

  return (
    <>
      {/* Only one copy of the tree is mounted. Rendering the inline body while
          the dialog is open re-rendered two full trees — 400 rows each on a
          large site — on every checkbox press. */}
      {maximized ? null : body('max-h-72', true)}
      <Dialog
        open={maximized}
        onOpenChange={setMaximized}
        size="xl"
        title={translateNow('agents.pagesFoundOnThisWebsite') || 'Pages found on this website'}
        description={translateNow('agents.youAreChargedPerPage') || 'You are charged per page — leave out what visitors never ask about.'}
      >
        {body('max-h-[60vh]', false)}
      </Dialog>
    </>
  );
}
