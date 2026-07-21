import { useEffect, useRef, useState } from 'react';
import { HexColorPicker, HexColorInput } from 'react-colorful';

export interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  /** Quick-pick swatches (recommended + presets). */
  swatches?: string[];
}

/**
 * ColorField — a hex color control: current swatch (opens a react-colorful
 * popover), a hex input, and quick-pick swatches. Built fresh on the new DS.
 */
export function ColorField({ label, value, onChange, swatches = [] }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const quick = swatches.filter((c, i) => swatches.indexOf(c) === i).slice(0, 6);

  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]">{label}</span>
      <div ref={ref} className="relative flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Pick ${label.toLowerCase()}`}
          className="h-9 w-9 shrink-0 rounded-lg border border-[var(--ds-border)] shadow-[var(--ds-shadow-sm)]"
          style={{ backgroundColor: value }}
        />
        <div className="flex h-9 items-center rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-2.5">
          <HexColorInput
            color={value}
            onChange={onChange}
            prefixed
            className="w-20 bg-transparent text-[13px] uppercase text-[var(--ds-text)] outline-none"
          />
        </div>

        {quick.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {quick.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => onChange(color)}
                aria-label={`Use ${color}`}
                title={color}
                className="h-6 w-6 rounded-md border border-[var(--ds-border)] transition-transform hover:scale-110"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        )}

        {open && (
          <div className="ds-colorpicker absolute left-0 top-11 z-20 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-2 shadow-[var(--ds-shadow-lg)]">
            <HexColorPicker color={value} onChange={onChange} />
          </div>
        )}
      </div>
    </div>
  );
}
