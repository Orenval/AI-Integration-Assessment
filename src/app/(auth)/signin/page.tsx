"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signInSchema } from "@/lib/validation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { AppLogo } from "@/components/app-logo";

export default function SignInPage() {
  const router = useRouter();
  const { setForgotPasswordEmail, refreshSession } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [showPassword, setShowPassword] = useState(false);
  const [expiredNotice] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return window.location.search.includes("expired=1");
    }
    return false;
  });

  useEffect(() => {
    ensureCsrfToken();
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError("");
    setErrors({});

    const sanitizedEmail = email.trim();
    // Client-side validation using shared Zod schema (Requirement 2)
    const clientValidation = signInSchema.safeParse({ email: sanitizedEmail, password });
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
      const res = await apiFetch<{ requiresVerification?: boolean }>(
        "/api/auth/signin",
        {
          body: JSON.stringify({ email: sanitizedEmail, password }),
        }
      );

      if (!res.success) {
        if (res.errors) {
          const fieldErrors: Record<string, string> = {};
          for (const [key, msgs] of Object.entries(res.errors)) {
            fieldErrors[key] = msgs[0];
          }
          setErrors(fieldErrors);
        } else {
          setGeneralError(
            res.retryAfter
              ? `${res.message} (Retry after ${res.retryAfter}s)`
              : res.message
          );
        }
        return;
      }

      if (res.data?.requiresVerification) {
        await refreshSession();
        router.push("/verify-email");
      } else {
        await refreshSession();
        router.push("/dashboard");
      }
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <main className="auth-card">
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
          <AppLogo size={48} />
        </div>
        <h1 className="auth-title">Sign In</h1>
        <p className="auth-subtitle">Enter your email and password to access your account.</p>

        {generalError && (
          <div className="alert-box error" role="alert">
            {generalError}
          </div>
        )}

        {expiredNotice && !generalError && (
          <div className="alert-box error" role="alert">
            Your session expired. Please sign in again to continue.
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
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

          <div className="form-group">
            <label htmlFor="password" className="form-label">
              Password
            </label>
            <div className="password-input-wrap">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                className={`form-input ${errors.password ? "error" : ""}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={errors.password ? "password-error" : undefined}
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
            {errors.password && (
              <span id="password-error" className="error-text">
                {errors.password}
              </span>
            )}
            <div className="auth-links-row">
              <span />
              <button
                type="button"
                className="btn-link"
                onClick={() => {
                  setForgotPasswordEmail(email);
                  router.push("/forgot-password");
                }}
              >
                Forgot password?
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading}
          >
            {isLoading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Don&apos;t have an account?</span>
          <Link href="/signup" className="btn-link">
            Sign Up
          </Link>
        </div>
      </main>
    </div>
  );
}
