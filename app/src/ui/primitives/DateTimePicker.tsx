import { DatePicker } from './DatePicker';
import { Input } from './Input';
import type { ControlSize } from './controlStyles';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function splitLocal(value: string): { date: string | null; time: string } {
  const [date, time] = value.split('T');
  return { date: date || null, time: time && TIME_PATTERN.test(time) ? time : '00:00' };
}

export interface DateTimePickerProps {
  /** `YYYY-MM-DDTHH:mm` (the `<input type="datetime-local">` format this
   * replaces), or `''` for unset. */
  value: string;
  onValueChange: (value: string) => void;
  /** Required: names both halves — "Starts date" / "Starts time". */
  label: string;
  disabled?: boolean;
  size?: ControlSize;
  className?: string;
}

/**
 * A date and a time of day, together — for the one case `DatePicker` alone
 * does not cover.
 *
 * The time half is a plain validated text field, not `<input type="time">`:
 * that control opens the SAME platform picker chrome `DatePicker`'s own
 * docblock explains leaving behind, on top of which several browsers render
 * it as a 12-hour AM/PM spinner with no way to force 24-hour entry, which
 * `starts_at`/`ends_at` need for an unambiguous `YYYY-MM-DDTHH:mm` payload.
 * Typing "14:30" is one motion; a spinner needs four.
 *
 * The time field is uncontrolled, keyed on `date`: every other keystroke of
 * "14:30" is an invalid `HH:MM` on its own, so a controlled field that only
 * ever reflected back a fully-parsed value would erase "1" the instant the
 * reader typed it. Letting the DOM own the field's live text — and only
 * resyncing it, by remounting, when a NEW date makes the previous typing
 * moot — means the reader can type freely and the parent still only ever
 * hears about a complete, valid time.
 */
export function DateTimePicker({
  value,
  onValueChange,
  label,
  disabled = false,
  size = 'md',
  className,
}: DateTimePickerProps) {
  const { date, time } = splitLocal(value);

  return (
    <div className={className ? className : 'flex gap-2'}>
      <div className="min-w-0 flex-1">
        <DatePicker
          label={`${label} date`}
          value={date}
          onValueChange={(nextDate) => onValueChange(nextDate ? `${nextDate}T${time}` : '')}
          disabled={disabled}
          size={size}
        />
      </div>
      <div className="w-24 shrink-0">
        <Input
          key={date ?? 'unset'}
          aria-label={`${label} time`}
          size={size}
          placeholder="HH:MM"
          inputMode="numeric"
          // The date half is what turns "" into a real value — a time typed
          // with no date has nothing to attach to, so this waits for one
          // rather than guessing today.
          disabled={disabled || !date}
          defaultValue={time}
          onChange={(event) => {
            const raw = event.target.value;
            if (date && TIME_PATTERN.test(raw)) onValueChange(`${date}T${raw}`);
          }}
        />
      </div>
    </div>
  );
}
