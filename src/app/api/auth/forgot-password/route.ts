// =============================================================================
// POST /api/auth/forgot-password — Request Password Reset Code
// =============================================================================
// This endpoint BOTH issues the first reset code and acts as the "resend code"
// action from the reset-code step. It therefore enforces the server-side
// resend cooldown itself: a new code request for an existing account before
// the previous code's resendCooldownUntil has elapsed is silently skipped
// (response stays identical) so no account-existence signal leaks.
//
// Requirements addressed:
// - Req 5:  Rate limiting with exponential backoff
// - Req 6:  Server-enforced resend cooldown (resendCooldownUntil in DB)
// - Req 7:  Account enumeration prevention — always returns the same generic
//           response whether or not the email is registered
// - Req 15: CSRF validation

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forgotPasswordSchema } from "@/lib/validation";
import { validateCsrfToken } from "@/lib/csrf";
import { checkRateLimit, recordFailedAttempt } from "@/lib/rate-limit";
import {
  generateResetCode,
  RESET_RESEND_COOLDOWN_MS,
} from "@/lib/reset-code";
import { RESET_CODE_TTL_MS } from "@/lib/auth-config";
import { sendPasswordResetEmail } from "@/lib/email";

// The generic response returned regardless of whether the email exists.
// This prevents account enumeration (Requirement 7).
const GENERIC_RESPONSE = {
  success: true,
  message: "A six-digit code has been sent to your email.",
};

export async function POST(request: Request): Promise<NextResponse> {
  // ---- CSRF check ----
  const csrfValid = await validateCsrfToken(request);
  if (!csrfValid) {
    return NextResponse.json(
      { success: false, message: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  // ---- Parse & validate body ----
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }

  const validation = forgotPasswordSchema.safeParse(body);
  if (!validation.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of validation.error.issues) {
      const field = issue.path.join(".");
      if (!errors[field]) errors[field] = [];
      errors[field].push(issue.message);
    }
    return NextResponse.json(
      { success: false, message: "Validation failed", errors },
      { status: 400 }
    );
  }

  const { email } = validation.data;
  const normalizedEmail = email.toLowerCase().trim();

  // ---- Rate limit check ----
  const rateLimit = await checkRateLimit(normalizedEmail, "forgot-password");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many requests. Please try again later.",
        retryAfter: rateLimit.retryAfter,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfter),
        },
      }
    );
  }

  // ---- Look up user (silent — do NOT leak existence) ----
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (user) {
    const now = new Date();

    // ---- Server-enforced resend cooldown (Requirement 6) ----
    // If the user's latest pending code is still within its resend window,
    // silently skip generating/sending a new one. We ALSO record a failed
    // rate-limit attempt so aggressive resend hammering eventually triggers
    // exponential backoff (identical to the resend-code route behavior for
    // the email-verification flow). The response stays identical either way.
    const latestCode = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    if (
      latestCode &&
      latestCode.resendCooldownUntil.getTime() > now.getTime()
    ) {
      await recordFailedAttempt(normalizedEmail, "forgot-password");
    } else {
      // Delete any previously pending (unused) codes — expired AND still-valid
      // ones (both have usedAt = null) — so only one valid code exists per user
      // at a time. Deleting rather than soft-marking matches the VerificationCode
      // lifecycle and prevents expired, never-used rows from accumulating.
      await prisma.passwordResetToken.deleteMany({
        where: { userId: user.id, usedAt: null },
      });

      const { code, codeHash } = await generateResetCode();

      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          codeHash,
          expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MS),
          resendCooldownUntil: new Date(
            now.getTime() + RESET_RESEND_COOLDOWN_MS
          ),
        },
      });

      await sendPasswordResetEmail(normalizedEmail, code, user.fullName);
    }
  } else {
    // User doesn't exist — record a rate limit attempt to throttle probing,
    // but do NOT reveal that the email isn't registered.
    await recordFailedAttempt(normalizedEmail, "forgot-password");
  }

  // Always return the same response (Requirement 7).
  return NextResponse.json(GENERIC_RESPONSE);
}