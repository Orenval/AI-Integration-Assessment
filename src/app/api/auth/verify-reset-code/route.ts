// =============================================================================
// POST /api/auth/verify-reset-code — Step 2 of the Forgot Password flow
// =============================================================================
// This endpoint ONLY verifies the reset code submitted on Step 2. It checks the
// code against the stored hash, confirms it is neither expired nor already
// used, and returns success (with a flowId identifying the exact token) or a
// generic failure. It does NOT touch the user's password and does NOT consume
// the token — consumption happens only on the successful Step 3 submit to
// /api/auth/reset-password.
//
// Requirements addressed:
// - Req 5:  Rate limiting with exponential backoff on repeated wrong attempts
// - Req 7:  Account enumeration prevention — every failure path returns the
//           SAME generic message, whether the email doesn't exist, the code is
//           wrong, expired, or already used.
// - Req 12: Single-use (usedAt) and time-limited (expiresAt) codes
// - Req 15: CSRF validation

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyResetCodeSchema } from "@/lib/validation";
import { validateCsrfToken } from "@/lib/csrf";
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

  const validation = verifyResetCodeSchema.safeParse(body);
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

  const { email, code } = validation.data;
  const normalizedEmail = email.toLowerCase().trim();

  // ---- Rate limit check (Requirement 5) ----
  const rateLimit = await checkRateLimit(normalizedEmail, "verify-reset-code");
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
    await recordFailedAttempt(normalizedEmail, "verify-reset-code");
    return INVALID_CODE_RESPONSE;
  }

  // ---- Find the latest pending reset code for this user ----
  const resetCode = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      usedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  // Any missing/invalid/expired/used code fails identically.
  const now = new Date();
  const isInvalid =
    !resetCode ||
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
    await recordFailedAttempt(normalizedEmail, "verify-reset-code");
    return INVALID_CODE_RESPONSE;
  }

  const validCode = resetCode!;

  // ---- Success: code verified. Do NOT consume it and do NOT touch the
  // password — Step 3 consumes the token via /api/auth/reset-password. ----
  return NextResponse.json({
    success: true,
    message: "Code verified",
    data: { flowId: validCode.id },
  });
}