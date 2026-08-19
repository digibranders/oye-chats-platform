import { forwardRef, type ReactNode } from 'react';
import { Field, Input } from '../../ui';
import { OTP_LENGTH } from './authFlow';

export interface OtpFieldProps {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
}

/**
 * The six-digit code, as one field.
 *
 * Both OTP screens used to disagree with themselves. Verification rendered six
 * separate boxes whose auto-submit only fired from the last one, so anyone who
 * backspaced to fix the third digit and retyped it ended up with a complete
 * code, no submission, and nothing on screen saying to press the button. The
 * password reset used a single free-text input with no numeric keyboard and no
 * length cap.
 *
 * One input answers both. `autocomplete="one-time-code"` is what lets iOS and
 * Chrome fill the code straight from the notification, paste needs no handler,
 * backspace is just backspace, and a screen reader announces one labelled field
 * instead of six anonymous ones. The caller submits when the value reaches its
 * full length, which is true however the digits arrived.
 */
export const OtpField = forwardRef<HTMLInputElement, OtpFieldProps>(function OtpField(
  { value, onChange, label = 'Six-digit code', hint, error, disabled, autoFocus },
  ref,
) {
  return (
    <Field label={label} hint={hint} error={error} required>
      <Input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={OTP_LENGTH}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder="000000"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        size="lg"
        className="figure text-center text-lg tracking-widest"
      />
    </Field>
  );
});
