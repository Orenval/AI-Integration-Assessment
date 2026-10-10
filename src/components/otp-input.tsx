"use client";

import { useRef, KeyboardEvent, ClipboardEvent, ChangeEvent } from "react";

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  id?: string;
}

export function OtpInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled = false,
  hasError = false,
  id = "otp-input",
}: OtpInputProps) {
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // Split value into array of characters up to `length`
  const digits = Array.from({ length }, (_, i) => value[i] || "");

  const focusInput = (index: number) => {
    if (index >= 0 && index < length && inputsRef.current[index]) {
      inputsRef.current[index]?.focus();
      inputsRef.current[index]?.select();
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>, index: number) => {
    const rawVal = e.target.value;
    const digit = rawVal.replace(/\D/g, "").slice(-1); // Take last entered digit

    const nextDigits = [...digits];
    nextDigits[index] = digit;
    const nextValue = nextDigits.join("");

    onChange(nextValue);

    if (digit && index < length - 1) {
      focusInput(index + 1);
    }

    if (nextValue.length === length && onComplete) {
      onComplete(nextValue);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === "Backspace") {
      if (!digits[index] && index > 0) {
        e.preventDefault();
        const nextDigits = [...digits];
        nextDigits[index - 1] = "";
        const nextValue = nextDigits.join("");
        onChange(nextValue);
        focusInput(index - 1);
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      focusInput(index - 1);
    } else if (e.key === "ArrowRight" && index < length - 1) {
      e.preventDefault();
      focusInput(index + 1);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pastedData) return;

    onChange(pastedData);
    const lastIndex = Math.min(pastedData.length, length) - 1;
    focusInput(lastIndex >= 0 ? lastIndex : 0);

    if (pastedData.length === length && onComplete) {
      onComplete(pastedData);
    }
  };

  return (
    <div
      className="otp-container"
      role="group"
      aria-label={`${length}-digit verification code`}
      id={id}
    >
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            inputsRef.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          value={digits[i]}
          onChange={(e) => handleChange(e, i)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          onPaste={handlePaste}
          disabled={disabled}
          autoComplete="one-time-code"
          className={`otp-box ${hasError ? "error" : ""} ${digits[i] ? "filled" : ""}`}
          aria-label={`Digit ${i + 1} of ${length}`}
        />
      ))}
    </div>
  );
}
