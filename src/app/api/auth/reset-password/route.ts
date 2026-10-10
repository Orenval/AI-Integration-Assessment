// =============================================================================
// POST /api/auth/reset-password — Step 3 of the Forgot Password flow
// =============================================================================
// Reached ONLY after Step 2 (verify-reset-code) succeeded. The form on Step 3
// contains password fields only; the verified code and its flowId (the token
// identifier returned by Step 2) are carried in client state and included in
// this request so the server can confirm it is the SAME, still-valid, still
// unconsumed token before updating the password. Only on THIS successful
// submit is the token consumed (deleted).
//
// Requirements addressed:
// - Req 7:  Account enumeration prevention — every failed path returns the
//           SAME generic message, whether the email doesn't exist, the code is
//           wrong, expired, or already used.
// - Req 8:  Invalidate ALL sessions on password reset
// - Req 9:  No session is issued on success — the user is returned to the
//           sign-in page and authenticates there as usual.
// - Req 12: Code is single-use (usedAt) and time-limited (expiresAt)
// - Req 15: CSRF validation
//
// The email address is part of the reset credential: it is required here so
// an attacker cannot replay an intercepted code without knowing which account
// it belongs to. Even if they guess it, the generic failure message never
// confirms a mismatch.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetPasswordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/password";
import { validateCsrfToken } from "@/lib/csrf";
import { invalidateAllUserSessions } from "@/lib/session";
import { checkRateLimit, recordFailedAttempt } from "@/lib/rate-limit";
import {
  hashResetCode,
  MAX_RESET_CODE_ATTEMPTS,
} from "@/lib/reset-code";

// Uniform response for ALL failure paths — no information leakage (Requirement 7).
const INVALID_CODE_RESPONSE = NextResponse.json(
  {
    success: false,
    message: "That reset code is invalid or has expired. Please request a new one.",
  },
  { status: 400 }
);

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

  const validation = resetPasswordSchema.safeParse(body);
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

  const { email, flowId, code, password } = validation.data;
  const normalizedEmail = email.toLowerCase().trim();

  // ---- Rate limit check (Requirement 5) ----
  const rateLimit = await checkRateLimit(normalizedEmail, "reset-password");
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

  // ---- Look up user (silent if missing — no information leakage) ----
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    // Throttle probes, but return the identical generic message.
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Find the exact token verified on Step 2 (scoped to the user) ----
  // Looked up by its identifier (flowId) so this step can operate only on the
  // SAME token that already passed verification — never the latest one, which
  // could have been superseded by a resend.
  const resetCode = await prisma.passwordResetToken.findFirst({
    where: {
      id: flowId,
      userId: user.id,
    },
  });

  // Any missing/invalid/expired/used code fails identically. The code hash is
  // re-confirmed so a client that reaches Step 3 must still prove possession
  // of the code (Step 2 merely unlocked the flow).
  const now = new Date();
  const isInvalid =
    !resetCode ||
    resetCode.usedAt !== null ||
    resetCode.expiresAt.getTime() < now.getTime() ||
    resetCode.attemptCount >= MAX_RESET_CODE_ATTEMPTS ||
    hashResetCode(code) !== resetCode.codeHash;

  if (isInvalid) {
    if (resetCode && resetCode.attemptCount < MAX_RESET_CODE_ATTEMPTS) {
      // A real, unexpired code was submitted with the wrong digits: count the
      // attempt (locks the code out at MAX_RESET_CODE_ATTEMPTS) and throttle.
      await prisma.passwordResetToken.update({
        where: { id: resetCode.id },
        data: { attemptCount: { increment: 1 } },
      });
    }
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  const validCode = resetCode!;

  // ---- Hash new password ----
  const newPasswordHash = await hashPassword(password);

  // ---- Atomic update: consume the code + update password ----
  await prisma.$transaction([
    // Consume the verified code by DELETING it (Requirement 12: single-use),
    // matching the VerificationCode lifecycle instead of a soft usedAt flag.
    // The usedAt guard keeps this concurrent-safe: a duplicate submission finds
    // nothing to delete (a no-op) rather than throwing on a missing row.
    prisma.passwordResetToken.deleteMany({
      where: { id: validCode.id, usedAt: null },
    }),
    // Update the user's password
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash },
    }),
  ]);

  // ---- Invalidate ALL sessions (Requirement 8) ----
  // A password reset should kill all active sessions so that any attacker
  // who had a stolen session is immediately logged out. No new session is
  // created — the user is sent back to the sign-in page to authenticate.
  await invalidateAllUserSessions(user.id);

  return NextResponse.json({
    success: true,
    message: "Password has been reset successfully.",
  });
}