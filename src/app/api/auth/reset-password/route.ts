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
// - Req 7:  Account enumeration prevention — generic message on failure
// - Req 8:  Invalidate ALL sessions on password reset
// - Req 9:  No session is issued on success — returned to sign-in page
// - Req 12: Code is single-use and time-limited
// - Req 15: CSRF validation
// - bcrypt compare with atomic attempt reservation and expiry handling

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetPasswordSchema } from "@/lib/validation";
import { hashPassword } from "@/lib/password";
import { validateCsrfToken } from "@/lib/csrf";
import { invalidateAllUserSessions } from "@/lib/session";
import { checkRateLimit, recordFailedAttempt } from "@/lib/rate-limit";
import { compareCode, DUMMY_CODE_HASH } from "@/lib/verification";
import { MAX_RESET_CODE_ATTEMPTS } from "@/lib/reset-code";

// Uniform response for non-expired failure paths — no information leakage.
const INVALID_CODE_RESPONSE = NextResponse.json(
  {
    success: false,
    message: "That reset code is invalid or has expired. Please request a new one.",
  },
  { status: 400 }
);

const EXPIRED_CODE_RESPONSE = (message = "That code has expired. Request a new one.") =>
  NextResponse.json(
    {
      success: false,
      message,
      expired: true,
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

  // ---- Look up user (silent if missing — equalized timing) ----
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    await compareCode(code, DUMMY_CODE_HASH);
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Find the exact token verified on Step 2 (scoped to the user) ----
  const resetCode = await prisma.passwordResetToken.findFirst({
    where: {
      id: flowId,
      userId: user.id,
    },
  });

  if (!resetCode || resetCode.usedAt !== null) {
    await compareCode(code, DUMMY_CODE_HASH);
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  const now = new Date();

  // ---- Check expiry ----
  if (resetCode.expiresAt.getTime() <= now.getTime()) {
    await compareCode(code, DUMMY_CODE_HASH);
    return EXPIRED_CODE_RESPONSE();
  }

  // ---- Check lockout ----
  if (resetCode.attemptCount >= MAX_RESET_CODE_ATTEMPTS) {
    await compareCode(code, DUMMY_CODE_HASH);
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Reserve an attempt before comparing (Step 3: atomic reservation) ----
  const reserveResult = await prisma.passwordResetToken.updateMany({
    where: {
      id: resetCode.id,
      attemptCount: { lt: MAX_RESET_CODE_ATTEMPTS },
      expiresAt: { gt: now },
      usedAt: null,
    },
    data: {
      attemptCount: { increment: 1 },
    },
  });

  if (reserveResult.count === 0) {
    const current = await prisma.passwordResetToken.findUnique({
      where: { id: resetCode.id },
    });
    if (!current || current.expiresAt.getTime() <= Date.now()) {
      return EXPIRED_CODE_RESPONSE();
    }
    await compareCode(code, DUMMY_CODE_HASH);
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Check expiry again in code ----
  if (resetCode.expiresAt.getTime() <= Date.now()) {
    return EXPIRED_CODE_RESPONSE();
  }

  // ---- Compare candidate code against bcrypt hash ----
  const isValid = await compareCode(code, resetCode.codeHash);
  if (!isValid) {
    await recordFailedAttempt(normalizedEmail, "reset-password");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Hash new password ----
  const newPasswordHash = await hashPassword(password);

  // ---- Atomic update: consume the code + update password ----
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({
      where: { id: resetCode.id, usedAt: null },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newPasswordHash },
    }),
  ]);

  // ---- Invalidate ALL sessions (Requirement 8) ----
  await invalidateAllUserSessions(user.id);

  return NextResponse.json({
    success: true,
    message: "Password has been reset successfully.",
  });
}