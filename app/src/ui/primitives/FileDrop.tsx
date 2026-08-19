import { useCallback, useId, useRef, useState, type DragEvent } from 'react';
import { Upload, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { formatBytes } from '../lib/formatters';
import { Alert } from '../feedback/Alert';

export interface FileDropProps {
  onFiles: (files: File[]) => void;
  /** e.g. `['.pdf', '.docx', '.txt']`. Also applied to the native picker. */
  accept?: readonly string[];
  maxSizeBytes?: number;
  maxFiles?: number;
  multiple?: boolean;
  label: string;
  hint?: string;
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
 */
export function FileDrop({
  onFiles,
  accept,
  maxSizeBytes,
  maxFiles,
  multiple = true,
  label,
  hint,
  disabled = false,
  className,
}: FileDropProps) {
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
          problems.push(`${file.name} is not a supported file type.`);
          continue;
        }
        if (maxSizeBytes && file.size > maxSizeBytes) {
          problems.push(
            `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(maxSizeBytes)} limit.`,
          );
          continue;
        }
        accepted.push(file);
      }

      const withinCount = maxFiles ? accepted.slice(0, maxFiles) : accepted;
      if (maxFiles && accepted.length > maxFiles) {
        problems.push(`Only the first ${maxFiles} files were added.`);
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
          'flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-8 text-center',
          'transition-colors duration-[var(--dur-fast)]',
          disabled
            ? 'cursor-not-allowed border-border bg-surface-sunken opacity-60'
            : 'cursor-pointer border-border-strong hover:border-accent-500 hover:bg-accent-50',
          dragging && 'border-accent-500 bg-accent-50',
        )}
      >
        <Upload aria-hidden className="mb-2 h-5 w-5 text-text-tertiary" />
        <span className="text-base font-medium text-text-primary">{label}</span>
        {hint ? <span className="mt-1 text-xs text-text-secondary">{hint}</span> : null}
        {accept && accept.length > 0 ? (
          <span className="mt-1.5 font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            {accept.join(' · ')}
            {maxSizeBytes ? ` · up to ${formatBytes(maxSizeBytes)}` : ''}
          </span>
        ) : null}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="sr-only"
          multiple={multiple}
          disabled={disabled}
          accept={accept?.join(',')}
          onChange={(event) => handleFiles(event.target.files)}
        />
      </label>

      {rejected.length > 0 ? (
        <Alert
          tone="warning"
          className="mt-2"
          action={
            <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setRejected([])}>
              <X aria-hidden className="h-3.5 w-3.5" />
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
