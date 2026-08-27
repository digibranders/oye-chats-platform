import type { KnowledgeSource } from '../../../types/domain';
import { t as translateNow } from '../../../i18n/i18n';
import { formatDate, formatNumber } from '../../../i18n/formatters';

/**
 * "12 pages" / "1 page" / "500+ pages", in the active language.
 *
 * English forms the plural by appending "s", so the markup used to do that
 * inline. Hindi does not, and neither do most languages, so the two forms are
 * separate keys. The "+" marks a capped discovery and is not copy.
 */
export function pageCountLabel(total: number, capped = false): string {
  const count = `${formatNumber(total)}${capped ? '+' : ''}`;
  const one = total === 1 && !capped;
  return (
    translateNow(one ? 'agents.pageOne' : 'agents.pageMany', { count }) ||
    `${count} page${one ? '' : 's'}`
  );
}

/** "Showing first 20 of 480 pages." */
export function showingFirstLabel(shown: number, total: number): string {
  const a = formatNumber(shown);
  const b = formatNumber(total);
  return translateNow('agents.showingFirstOf', { shown: a, total: b }) ||
    `Showing first ${a} of ${b} pages.`;
}

/** "Finished - your AI learned 12 pages." */
export function crawlFinishedLabel(pages: number): string {
  const label = pageCountLabel(pages);
  return translateNow('agents.crawlFinished', { pages: label }) ||
    `Finished - your AI learned ${label}.`;
}

/** "1 document" / "3 documents", same plural rule as pageCountLabel. */
export function documentCountLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.documentOne' : 'agents.documentMany', { count }) ||
    `${count} document${n === 1 ? '' : 's'}`
  );
}

/** "1 file" / "12 files", same plural rule as pageCountLabel. */
export function fileCountLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.fileOne' : 'agents.fileMany', { count }) ||
    `${count} file${n === 1 ? '' : 's'}`
  );
}

/** "1 word" / "1,204 words", same plural rule as pageCountLabel. */
export function wordCountLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.wordOne' : 'agents.wordMany', { count }) ||
    `${count} word${n === 1 ? '' : 's'}`
  );
}

/** "1 credit" / "250 credits", same plural rule as pageCountLabel. */
export function creditCountLabel(total: number): string {
  const count = formatNumber(total);
  return (
    translateNow(total === 1 ? 'agents.creditOne' : 'agents.creditMany', { count }) ||
    `${count} credit${total === 1 ? '' : 's'}`
  );
}

/** True when a source name is a crawled website (vs an uploaded file). */
export function isUrlSource(name: string): boolean {
  return name.startsWith('http://') || name.startsWith('https://');
}

/** Prepend https:// when the user typed a bare domain. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The registrable host for a source, used to detect "already added" sites. */
export function hostOf(name: string): string {
  return name
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

/** Number of learned units (pages for websites, pages/sections for documents). */
export function unitCountOf(source: KnowledgeSource): number {
  if (isUrlSource(source.name)) return source.page_count ?? 0;
  return source.doc_page_count ?? source.chunk_count ?? 0;
}

/** Human label for a source's size, e.g. "12 pages" / "4 sections". */
export function unitLabelOf(source: KnowledgeSource): string {
  const n = unitCountOf(source);
  if (isUrlSource(source.name)) return `${n} page${n === 1 ? '' : 's'}`;
  const unit = source.doc_page_count != null ? 'page' : 'section';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Sum of website pages across all crawled sources. */
export function totalWebsitePages(sources: readonly KnowledgeSource[]): number {
  return sources.reduce((sum, s) => sum + (isUrlSource(s.name) ? s.page_count ?? 0 : 0), 0);
}

/** Short relative date, e.g. "Today", "3 days ago", or a date fallback. */
export function formatRelativeDate(iso?: string): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return translateNow('agents.today') || 'Today';
  if (days === 1) return translateNow('agents.yesterday') || 'Yesterday';
  if (days < 30) {
    const count = formatNumber(days);
    return translateNow('agents.daysAgo', { count }) || `${count} days ago`;
  }
  return formatDate(new Date(then), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Most recent ingestion timestamp across all sources, or undefined. */
export function lastUpdatedIso(sources: readonly KnowledgeSource[]): string | undefined {
  let latest: number | null = null;
  for (const s of sources) {
    if (!s.ingested_at) continue;
    const t = new Date(s.ingested_at).getTime();
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? undefined : new Date(latest).toISOString();
}

// Upload constraints - mirror the legacy KnowledgeBase limits so the UI rejects
// files the backend would reject anyway (api/app/api/ingestion routes).
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'] as const;
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface FileFilterResult {
  accepted: File[];
  rejected: string[];
}

/** Keep only supported, within-size files; report why the rest were dropped. */
export function filterUploadFiles(fileList: FileList | File[]): FileFilterResult {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of Array.from(fileList)) {
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    const supported =
      SUPPORTED_MIME_TYPES.has(file.type) ||
      (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
    if (!supported) {
      rejected.push(
      translateNow('agents.rejectedUnsupported', { name: file.name }) ||
        `${file.name} - unsupported file type`,
    );
      continue;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      rejected.push(
      translateNow('agents.rejectedTooLarge', { name: file.name }) ||
        `${file.name} - larger than 10 MB`,
    );
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
}
