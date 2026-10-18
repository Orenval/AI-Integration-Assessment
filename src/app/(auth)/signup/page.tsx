"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signUpSchema, passwordRules } from "@/lib/validation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import { useAuth } from "@/context/auth-context";
import { AppLogo } from "@/components/app-logo";

export default function SignUpPage() {
  const router = useRouter();
  const { refreshSession } = useAuth();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const [passwordTouched, setPasswordTouched] = useState(false);
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    ensureCsrfToken();
  }, []);

  // Validate a single field against the Zod schema and set/clear its error.
  const validateField = useCallback(
    (field: "fullName" | "email" | "password", value: string) => {
      const result = signUpSchema.shape[field].safeParse(value);
      setErrors((prev) => {
        if (result.success) {
          if (field in prev) {
            const next = { ...prev };
            delete next[field];
            return next;
          }
          return prev;
        }
        return { ...prev, [field]: result.error.issues[0].message };
      });
    },
    []
  );

  // onChange helpers: update value, mark as touched, and clear error when value is now valid
  const handleFullNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setFullName(v);
      setTouchedFields((prev) => ({ ...prev, fullName: true }));
      const r = signUpSchema.shape.fullName.safeParse(v);
      if (r.success) {
        setErrors((prev) => {
          if ("fullName" in prev) {
            const next = { ...prev };
            delete next.fullName;
            return next;
          }
          return prev;
        });
      }
    },
    []
  );

  const handleEmailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setEmail(v);
      setTouchedFields((prev) => ({ ...prev, email: true }));
      const r = signUpSchema.shape.email.safeParse(v);
      if (r.success) {
        setErrors((prev) => {
          if ("email" in prev) {
            const next = { ...prev };
            delete next.email;
            return next;
          }
          return prev;
        });
      }
    },
    []
  );

  const handlePasswordChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPassword(e.target.value);
      setPasswordTouched(true);
    },
    []
  );

  // onBlur: validate field only if it has been touched (user interacted with it)
  const handleFullNameBlur = useCallback(
    () => {
      if (touchedFields.fullName) {
        validateField("fullName", fullName);
      }
    },
    [fullName, touchedFields.fullName, validateField]
  );

  const handleEmailBlur = useCallback(
    () => {
      if (touchedFields.email) {
        validateField("email", email);
      }
    },
    [email, touchedFields.email, validateField]
  );

  const handlePasswordBlur = useCallback(
    () => validateField("password", password),
    [password, validateField]
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setGeneralError("");
    setErrors({});

    const sanitizedFullName = fullName.trim();
    const sanitizedEmail = email.trim();

    const clientValidation = signUpSchema.safeParse({
      fullName: sanitizedFullName,
      email: sanitizedEmail,
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

    setIsLoading(true);

    try {
      const res = await apiFetch<{ requiresVerification?: boolean }>(
        "/api/auth/signup",
        {
          body: JSON.stringify({
            fullName: sanitizedFullName,
            email: sanitizedEmail,
            password,
          }),
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

      await refreshSession();
      router.push("/verify-email");
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
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-subtitle">Sign up with your email to get started.</p>

        {generalError && (
          <div className="alert-box error" role="alert">
            {generalError}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="fullName" className="form-label">
              Full Name
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              autoComplete="name"
              autoFocus
              required
              className={`form-input ${errors.fullName ? "error" : ""}`}
              value={fullName}
              onChange={handleFullNameChange}
              onBlur={handleFullNameBlur}
              aria-describedby={errors.fullName ? "fullName-error" : undefined}
            />
            {errors.fullName && (
              <span id="fullName-error" className="error-text">
                {errors.fullName}
              </span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="email" className="form-label">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={`form-input ${errors.email ? "error" : ""}`}
              value={email}
              onChange={handleEmailChange}
              onBlur={handleEmailBlur}
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
                autoComplete="new-password"
                required
                className="form-input"
                value={password}
                onChange={handlePasswordChange}
                onBlur={handlePasswordBlur}
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

          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading}
          >
            {isLoading ? "Creating account..." : "Sign Up"}
          </button>
        </form>

        <div className="auth-footer">
          <span>Already have an account?</span>
          <Link href="/signin" className="btn-link">
            Sign In
          </Link>
        </div>
      </main>
    </div>
  );
}
