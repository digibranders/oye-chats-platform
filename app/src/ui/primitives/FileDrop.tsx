import { useCallback, useId, useRef, useState, type DragEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Eyebrow } from './Misc';
import { Progress } from './Progress';
import { formatBytes } from '../lib/formatters';
import { Alert } from '../feedback/Alert';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

export interface FileDropProps {
  onFiles: (files: File[]) => void;
  /** e.g. `['.pdf', '.docx', '.txt']`. Also applied to the native picker. */
  accept?: readonly string[];
  maxSizeBytes?: number;
  maxFiles?: number;
  multiple?: boolean;
  label: string;
  hint?: string;
  /**
   * What has been chosen, so the zone can say so.
   *
   * The docblock below named "no list of what had been chosen" as the defect the
   * previous seven file inputs shared, and then did not render one — so every
   * consumer built its own, which is how seven of them happened.
   */
  files?: readonly File[];
  onRemove?: (file: File) => void;
  /**
   * Upload progress per file name: 0–100, or `null` for indeterminate.
   *
   * `Progress` already has an indeterminate mode built for exactly this, and the
   * one component in the system that uploads could not show it.
   */
  progress?: Record<string, number | null>;
  disabled?: boolean;
  className?: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * A drop zone with a real file input behind it.
 *
 * The previous app had seven file inputs and exactly one of them accepted a
 * drop; the rest were bare `<input type="file">` with no validation, no size
 * limit, and no list of what had been chosen. Validation lives here so a
 * rejected file is explained the moment it is dropped — rather than as a server
 * error after an upload the user has already spent credits on.
 *
 * The zone is a `<label>` wrapping a visually-hidden input rather than a div
 * with a click handler, so keyboard and screen-reader users reach the platform's
 * own file picker with no extra work.
 *
 * The focus ring is drawn on the label via `peer-focus-visible`. `sr-only` clips
 * the real input to a 1 × 1 rect, so the global outline was being painted on a
 * one-pixel box and was invisible — tabbing through the knowledge-base page hit
 * the drop zone and showed nothing at all, while this docblock claimed the
 * opposite.
 */
export function FileDrop({
  onFiles,
  accept,
  maxSizeBytes,
  maxFiles,
  multiple = true,
  label,
  hint,
  files,
  onRemove,
  progress,
  disabled = false,
  className,
}: FileDropProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  // Drag events fire for every child element, so a plain boolean flickers as the
  // pointer crosses the icon and the caption. Counting enter/leave pairs is the
  // only reliable way to know the pointer has actually left the zone.
  const dragDepth = useRef(0);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list || disabled) return;
      const problems: string[] = [];
      const accepted: File[] = [];

      for (const file of Array.from(list)) {
        if (accept && accept.length > 0 && !accept.includes(extensionOf(file.name))) {
          problems.push(
            translateNow('ds.fileNotSupportedType', { name: file.name }) ||
              `${file.name} is not a supported file type.`,
          );
          continue;
        }
        if (maxSizeBytes && file.size > maxSizeBytes) {
          problems.push(
            translateNow('ds.fileOverLimit', {
              name: file.name,
              size: formatBytes(file.size),
              limit: formatBytes(maxSizeBytes),
            }) || `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(maxSizeBytes)} limit.`,
          );
          continue;
        }
        accepted.push(file);
      }

      const withinCount = maxFiles ? accepted.slice(0, maxFiles) : accepted;
      if (maxFiles && accepted.length > maxFiles) {
        problems.push(
          translateNow('ds.onlyFirstFilesAdded', { count: maxFiles }) ||
            `Only the first ${maxFiles} files were added.`,
        );
      }

      setRejected(problems);
      if (withinCount.length > 0) onFiles(withinCount);
      // Reset, so choosing the same file twice in a row still fires a change.
      if (inputRef.current) inputRef.current.value = '';
    },
    [accept, disabled, maxFiles, maxSizeBytes, onFiles],
  );

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  }

  return (
    <div className={className}>
      <label
        htmlFor={inputId}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepth.current += 1;
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-7 text-center',
          'transition-colors duration-[var(--dur-fast)]',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-accent-500',
          'peer-focus-visible:outline-offset-2',
          disabled
            ? 'cursor-not-allowed border-border bg-surface-sunken text-text-disabled'
            : 'cursor-pointer border-border-strong hover:border-accent-500 hover:bg-accent-50',
          dragging && 'border-accent-500 bg-accent-50',
        )}
      >
        {/* The input comes first so `peer-*` can reach the content after it —
            a sibling combinator only looks forward. */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="peer sr-only"
          multiple={multiple}
          disabled={disabled}
          accept={accept?.join(',')}
          onChange={(event) => handleFiles(event.target.files)}
        />
        <Upload
          aria-hidden
          className={cn('mb-2 h-icon-lg w-icon-lg', disabled ? 'text-text-disabled' : 'text-text-tertiary')}
        />
        <span className={cn('text-base font-medium', disabled ? 'text-text-disabled' : 'text-text-primary')}>
          {label}
        </span>
        {hint ? (
          <span className={cn('mt-1 text-xs', disabled ? 'text-text-disabled' : 'text-text-secondary')}>
            {hint}
          </span>
        ) : null}
        {accept && accept.length > 0 ? (
          // `as="span"`: a `<p>` is not valid inside a `<label>`'s phrasing
          // content, which is why this line used to re-type `Eyebrow`'s classes.
          <Eyebrow as="span" className="mt-1.5">
            {accept.join(' · ')}
            {maxSizeBytes
              ? translateNow('ds.upToSize', { size: formatBytes(maxSizeBytes) }) ||
                ` · up to ${formatBytes(maxSizeBytes)}`
              : ''}
          </Eyebrow>
        ) : null}
      </label>

      {files && files.length > 0 ? (
        <ul className="mt-1.5 border-t border-border">
          {files.map((file) => {
            const value = progress?.[file.name];
            const uploading = progress ? file.name in progress : false;
            return (
              <li
                key={`${file.name}-${file.size}`}
                className="flex min-h-row-compact items-center gap-3 border-b border-border py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{file.name}</span>
                  {uploading ? (
                    <Progress
                      className="mt-1"
                      size="sm"
                      value={value ?? null}
                      // The row above already prints the file name; this bar is
                      // 4px of chrome under it, not a labelled figure.
                      hideLabel
                      label={`Uploading ${file.name}`}
                    />
                  ) : null}
                </span>
                <span className="figure shrink-0 text-xs text-text-tertiary">
                  {formatBytes(file.size)}
                </span>
                {onRemove ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => onRemove(file)}
                  >
                    <X aria-hidden />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rejected.length > 0 ? (
        <Alert
          tone="warning"
          className="mt-1.5"
          action={
            <Button size="icon-sm" variant="ghost" aria-label={t('ds.dismiss') || 'Dismiss'} onClick={() => setRejected([])}>
              <X aria-hidden />
            </Button>
          }
        >
          <ul className="space-y-0.5">
            {rejected.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
