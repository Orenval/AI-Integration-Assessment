"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { verifyEmailSchema } from "@/lib/validation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { OtpInput } from "@/components/otp-input";
import { AppLogo } from "@/components/app-logo";

interface CooldownData {
  emailVerified?: boolean;
  resendCooldownUntil?: string | null;
  retryAfter?: number;
}

export default function VerifyEmailPage() {
  const router = useRouter();
  const { refreshSession, signOut, user } = useAuth();

  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number>(0);
  const [isResending, setIsResending] = useState(false);

  const formRef = useRef<HTMLFormElement>(null);

  // Interval timer ticks every second while cooldown is active
  useEffect(() => {
    if (!cooldownUntil) return;

    const timer = setInterval(() => {
      const rem = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setRemaining(rem);
      if (rem === 0) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const syncCooldown = useCallback(
    (res: {
      data?: CooldownData;
      retryAfter?: number;
      resendCooldownUntil?: string;
    }) => {
      const serverUntil =
        res.resendCooldownUntil ?? res.data?.resendCooldownUntil;
      const serverRetryAfter = res.retryAfter ?? res.data?.retryAfter;
      if (serverUntil) {
        const targetMs = new Date(serverUntil).getTime();
        setCooldownUntil(targetMs);
        setRemaining(Math.max(0, Math.ceil((targetMs - Date.now()) / 1000)));
      } else if (serverRetryAfter && serverRetryAfter > 0) {
        const targetMs = Date.now() + serverRetryAfter * 1000;
        setCooldownUntil(targetMs);
        setRemaining(serverRetryAfter);
      } else {
        setCooldownUntil(null);
        setRemaining(0);
      }
    },
    []
  );

  const handleSessionExpired = useCallback(async () => {
    try {
      await fetch("/api/auth/signout", { method: "GET" });
    } catch {
      // continue to redirect regardless
    }
    router.replace("/signin?expired=1");
  }, [router]);

  useEffect(() => {
    ensureCsrfToken();
    (async () => {
      try {
        const res = await apiFetch<CooldownData>("/api/auth/resend-code", {
          method: "GET",
        });
        if (res.status === 401) {
          handleSessionExpired();
          return;
        }
        if (res.success) syncCooldown(res);
      } catch {
        // Ignore
      }
    })();
  }, [syncCooldown, handleSessionExpired]);

  const submitCode = async (verificationCode: string) => {
    setGeneralError("");
    setSuccessMessage("");
    setErrors({});

    const clientValidation = verifyEmailSchema.safeParse({ code: verificationCode });
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
      const res = await apiFetch<{ expired?: boolean }>("/api/auth/verify-email", {
        body: JSON.stringify({ code: verificationCode }),
      });

      if (res.status === 401) {
        return handleSessionExpired();
      }

      if (!res.success) {
        if (res.data?.expired || res.message?.toLowerCase().includes("expired")) {
          setGeneralError("That code has expired. Request a new one.");
        } else {
          setGeneralError(res.message);
        }
        return;
      }

      setSuccessMessage("Email verified successfully! Redirecting...");
      await refreshSession();
      setTimeout(() => {
        router.push("/dashboard");
      }, 1000);
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submitCode(code);
  };

  const handleResend = async () => {
    if (remaining > 0 || isResending) return;

    setGeneralError("");
    setSuccessMessage("");
    setIsResending(true);

    try {
      const res = await apiFetch<CooldownData>("/api/auth/resend-code", {
        body: JSON.stringify({}),
      });

      if (res.status === 401) {
        return handleSessionExpired();
      }

      if (!res.success) {
        syncCooldown(res);
        setGeneralError(res.message);
        return;
      }

      setSuccessMessage(res.message);
      syncCooldown(res);
    } catch {
      setGeneralError("Failed to resend verification code. Please try again.");
    } finally {
      setIsResending(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace("/signup");
  };

  return (
    <div className="auth-container">
      <main className="auth-card">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
          <AppLogo size={48} />
        </div>
        <h1 className="auth-title">Verify your email</h1>
        <p className="auth-subtitle">
          We sent a 6-digit verification code to{" "}
          <strong>{user?.email || "your email address"}</strong>. Enter it below to activate your account.
        </p>

        {generalError && (
          <div className="alert-box error" role="alert">
            {generalError}
          </div>
        )}

        {successMessage && (
          <div className="alert-box success" role="status">
            {successMessage}
          </div>
        )}

        <form ref={formRef} onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="otp-input" className="form-label">
              6-Digit Verification Code
            </label>

            <OtpInput
              id="otp-input"
              value={code}
              onChange={setCode}
              onComplete={(completedCode) => {
                setCode(completedCode);
                submitCode(completedCode);
              }}
              disabled={isLoading}
              hasError={Boolean(errors.code)}
            />

            {errors.code && (
              <span id="code-error" className="error-text">
                {errors.code}
              </span>
            )}
          </div>

          <div className="email-help-note">
            Can&apos;t find the verification email? Check your spam or junk folder.
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading || code.length !== 6}
            style={{ marginTop: "1.25rem" }}
          >
            {isLoading ? "Verifying..." : "Verify Code"}
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

          <div>
            <span>Entered the wrong email address? </span>
            <button
              type="button"
              className="btn-link"
              onClick={handleSignOut}
            >
              Sign out &amp; try again
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
