"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyResetCodeSchema,
  passwordRules,
} from "@/lib/validation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { OtpInput } from "@/components/otp-input";
import { AppLogo } from "@/components/app-logo";

const RESEND_COOLDOWN_S = 60;

export default function ForgotPasswordPage() {
  const router = useRouter();
  const { consumeForgotPasswordEmail } = useAuth();

  const [step, setStep] = useState<"email" | "code" | "password">("email");
  const [email, setEmail] = useState("");
  const [flowId, setFlowId] = useState("");

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [isResending, setIsResending] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const consumeEmailRef = useRef(consumeForgotPasswordEmail);

  useEffect(() => {
    ensureCsrfToken();
    setEmail(consumeEmailRef.current());
  }, []);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = setInterval(() => {
      const rem = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setRemaining(rem);
      if (rem === 0) {
        clearInterval(timer);
        setCooldownUntil(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  const goBackToEmailStep = useCallback(() => {
    setStep("email");
    setGeneralError("");
    setSuccessMessage("");
    setFlowId("");
    setCode("");
    setPassword("");
    setConfirmPassword("");
    setPasswordTouched(false);
    setErrors({});
  }, []);

  // ---- Step 1: request the reset code ----
  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError("");
    setSuccessMessage("");
    setErrors({});

    const sanitizedEmail = email.trim();

    const clientValidation = forgotPasswordSchema.safeParse({ email: sanitizedEmail });
    if (!clientValidation.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of clientValidation.error.issues) {
        const field = issue.path[0] as string;
        if (!fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      const res = await apiFetch("/api/auth/forgot-password", {
        body: JSON.stringify({ email: sanitizedEmail }),
      });

      if (!res.success) {
        setGeneralError(
          res.retryAfter
            ? `${res.message} (Retry after ${res.retryAfter}s)`
            : res.message
        );
        return;
      }

      setCooldownUntil(Date.now() + RESEND_COOLDOWN_S * 1000);
      setStep("code");
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordChange = useCallback((v: string) => {
    setPassword(v);
    setPasswordTouched(true);
  }, []);

  const handleResend = async () => {
    if (remaining > 0 || isResending) return;

    setGeneralError("");
    setSuccessMessage("");
    setIsResending(true);

    try {
      const sanitizedEmail = email.trim();
      await apiFetch("/api/auth/forgot-password", {
        body: JSON.stringify({ email: sanitizedEmail }),
      });

      setCode("");
      setFlowId("");
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_S * 1000);
    } catch {
      setGeneralError("Failed to resend the reset code. Please try again.");
    } finally {
      setIsResending(false);
    }
  };

  // ---- Step 2: verify the reset code ----
  const submitResetCode = async (codeToVerify: string) => {
    setGeneralError("");
    setErrors({});

    const sanitizedEmail = email.trim();
    const clientValidation = verifyResetCodeSchema.safeParse({ email: sanitizedEmail, code: codeToVerify });
    if (!clientValidation.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of clientValidation.error.issues) {
        const field = issue.path[0] as string;
        if (!fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setIsVerifying(true);

    try {
      const res = await apiFetch<{ flowId: string }>(
        "/api/auth/verify-reset-code",
        {
          body: JSON.stringify({ email: sanitizedEmail, code: codeToVerify }),
        }
      );

      if (!res.success) {
        if (res.retryAfter) {
          setGeneralError(
            `${res.message} (Retry after ${res.retryAfter}s)`
          );
        } else if (res.errors?.code) {
          setErrors({ code: res.errors.code[0] });
        } else {
          setErrors({ code: res.message });
        }
        return;
      }

      setFlowId(res.data?.flowId ?? "");
      setErrors({});
      setStep("password");
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyCodeSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitResetCode(code);
  };

  // ---- Step 3: set new password ----
  const handlePasswordSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError("");
    setSuccessMessage("");
    setErrors({});

    if (password !== confirmPassword) {
      setErrors((prev) => ({
        ...prev,
        confirmPassword: "Passwords do not match",
      }));
      return;
    }

    const sanitizedEmail = email.trim();
    const clientValidation = resetPasswordSchema.safeParse({
      email: sanitizedEmail,
      flowId,
      code,
      password,
    });
    if (!clientValidation.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of clientValidation.error.issues) {
        const field = issue.path[0] as string;
        if (!fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setIsResetting(true);

    try {
      const res = await apiFetch<{ expired?: boolean }>("/api/auth/reset-password", {
        body: JSON.stringify({ email: sanitizedEmail, flowId, code, password }),
      });

      if (!res.success) {
        if (res.data?.expired || res.message?.toLowerCase().includes("expired")) {
          setStep("email");
          setGeneralError("That code has expired. Request a new one.");
          setFlowId("");
          setCode("");
          setPassword("");
          setConfirmPassword("");
          setPasswordTouched(false);
          setErrors({});
          return;
        }

        setGeneralError(
          res.retryAfter
            ? `${res.message} (Retry after ${res.retryAfter}s)`
            : res.message
        );
        return;
      }

      setSuccessMessage("Password reset successfully! Redirecting to sign in...");

      redirectTimer.current = setTimeout(() => {
        router.push("/signin");
      }, 1500);
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsResetting(false);
    }
  };

  // =========================================================================
  // Step 1 — Email entry
  // =========================================================================
  if (step === "email") {
    return (
      <div className="auth-container">
        <main className="auth-card">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
            <AppLogo size={48} />
          </div>
          <h1 className="auth-title">Forgot Password</h1>
          <p className="auth-subtitle">
            Enter your email and we&apos;ll send you a 6-digit code to reset your password.
          </p>

          {generalError && (
            <div className="alert-box error" role="alert">
              {generalError}
            </div>
          )}

          <form onSubmit={handleEmailSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="email" className="form-label">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                className={`form-input ${errors.email ? "error" : ""}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={errors.email ? "email-error" : undefined}
              />
              {errors.email && (
                <span id="email-error" className="error-text">
                  {errors.email}
                </span>
              )}
            </div>

            <button type="submit" className="btn-primary" disabled={isLoading}>
              {isLoading ? "Sending code..." : "Send Reset Code"}
            </button>

            <div className="auth-footer">
              <Link href="/signin" className="btn-link">
                Back to Sign In
              </Link>
            </div>
          </form>
        </main>
      </div>
    );
  }

  // =========================================================================
  // Step 2 — Verify code
  // =========================================================================
  if (step === "code") {
    return (
      <div className="auth-container">
        <main className="auth-card">
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
            <AppLogo size={48} />
          </div>
          <h1 className="auth-title">Enter Reset Code</h1>
          <p className="auth-subtitle">
            A 6-digit code has been sent to <strong>{email.trim()}</strong>.
          </p>

          {generalError && (
            <div className="alert-box error" role="alert">
              {generalError}
            </div>
          )}

          <form onSubmit={handleVerifyCodeSubmit} noValidate>
            <div className="form-group">
              <label htmlFor="code-otp" className="form-label">
                6-Digit Reset Code
              </label>

              <OtpInput
                id="code-otp"
                value={code}
                onChange={setCode}
                onComplete={(completedCode) => {
                  setCode(completedCode);
                  submitResetCode(completedCode);
                }}
                disabled={isVerifying}
                hasError={Boolean(errors.code)}
              />

              {errors.code && (
                <span id="code-error" className="error-text">
                  {errors.code}
                </span>
              )}
            </div>

            <div className="email-help-note">
              Can&apos;t find the reset email? Check your spam or junk folder.
            </div>

            <button
              type="submit"
              className="btn-primary"
              disabled={isVerifying || code.length !== 6}
              style={{ marginTop: "1.25rem" }}
            >
              {isVerifying ? "Verifying..." : "Verify Code"}
            </button>
          </form>

          <div className="auth-footer" style={{ flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", justifyContent: "center", gap: "0.375rem" }}>
              <span>Didn&apos;t receive a code?</span>
              <button
                type="button"
                className="btn-link"
                onClick={handleResend}
                disabled={remaining > 0 || isResending}
              >
                {remaining > 0
                  ? `Resend available in ${remaining}s`
                  : isResending
                  ? "Sending..."
                  : "Resend Code"}
              </button>
            </div>
            <button
              type="button"
              className="btn-link"
              onClick={goBackToEmailStep}
            >
              Use a different email address
            </button>
          </div>
        </main>
      </div>
    );
  }

  // =========================================================================
  // Step 3 — Set new password
  // =========================================================================
  return (
    <div className="auth-container">
      <main className="auth-card">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
          <AppLogo size={48} />
        </div>
        <h1 className="auth-title">Set New Password</h1>
        <p className="auth-subtitle">
          Enter a new password for your account. It will apply immediately.
        </p>

        {generalError && (
          <div className="alert-box error" role="alert">
            {generalError}
          </div>
        )}

        {successMessage && (
          <div className="alert-box success" role="status">
            <div>{successMessage}</div>
            <div className="redirect-progress-wrap">
              <div className="redirect-progress-bar" />
            </div>
          </div>
        )}

        <form onSubmit={handlePasswordSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="password" className="form-label">
              New Password
            </label>
            <div className="password-input-wrap">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                className="form-input"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                aria-describedby={passwordTouched ? "password-checklist" : undefined}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((prev) => !prev)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {passwordTouched && (
              <div
                id="password-checklist"
                className="password-checklist"
                aria-live="polite"
              >
                {passwordRules.map((rule) => {
                  const met = rule.test(password);
                  return (
                    <span
                      key={rule.id}
                      className={`password-rule ${met ? "met" : ""}`}
                    >
                      <span className="password-rule-indicator" aria-hidden="true">
                        {met ? "\u2713" : "\u25CB"}
                      </span>
                      {rule.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword" className="form-label">
              Confirm New Password
            </label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              className={`form-input ${errors.confirmPassword ? "error" : ""}`}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              aria-describedby={errors.confirmPassword ? "confirmPassword-error" : undefined}
            />
            {errors.confirmPassword && (
              <span id="confirmPassword-error" className="error-text">
                {errors.confirmPassword}
              </span>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={isResetting || successMessage.length > 0}
          >
            {isResetting ? "Resetting..." : "Reset Password"}
          </button>

          <div className="auth-footer">
            <Link href="/signin" className="btn-link">
              Back to Sign In
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}