// =============================================================================
// /api/auth/resend-code — Resend Verification Code & Cooldown Status
// =============================================================================
// RESEND COOLDOWN — ENFORCED SERVER-SIDE (source of truth)
// ---------------------------------------------------------------------------
// Requirement: "Resend cooldown, enforced server-side". Every verification
// code (created by signup, or re-created by a resend) stamps
// resendCooldownUntil = now + 60s in the database (see RESEND_COOLDOWN_MS in
// src/lib/verification.ts). This route is the authoritative gate:
//
//   GET  /api/auth/resend-code → returns the user's current resendCooldownUntil
//                                timestamp + remaining seconds so the client
//                                countdown can sync to it on load and after
//                                refreshes, and across multiple tabs/devices.
//   POST /api/auth/resend-code → rejects with HTTP 429 + Retry-After (and the
//                                exact resendCooldownUntil timestamp) if the
//                                window has NOT elapsed; otherwise generates a
//                                new code, sends the email, and stamps a fresh
//                                60-second cooldown — returning that new
//                                timestamp so the client can re-sync.
//
// The client-side countdown never decides anything: it only reflects the DB
// timestamp returned/acked by this route.
//
// Requirement 5:  Rate limiting with exponential backoff
// Requirement 6:  Server-side resend cooldown (resendCooldownUntil in DB)
// Requirement 15: CSRF validation

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { validateSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import { checkRateLimit, recordFailedAttempt } from "@/lib/rate-limit";
import {
  generateVerificationCode,
  RESEND_COOLDOWN_MS,
} from "@/lib/verification";
import { VERIFICATION_CODE_TTL_MS } from "@/lib/auth-config";
import { sendVerificationEmail } from "@/lib/email";

// ===========================================================================
// GET /api/auth/resend-code — Cooldown Status
// ===========================================================================
// Returns the resendCooldownUntil timestamp for the current user/session so
// the verification screen can restore a live countdown from the server's
// truth — handling page refreshes mid-countdown and multiple open tabs
// (each tab re-syncs to the same DB timestamp, never a client-only timer).
export async function GET(): Promise<NextResponse> {
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  if (sessionData.user.emailVerified) {
    return NextResponse.json({
      success: true,
      message: "Email already verified",
      data: { emailVerified: true, resendCooldownUntil: null, retryAfter: 0 },
    });
  }

  const latestCode = await prisma.verificationCode.findFirst({
    where: { userId: sessionData.user.id, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latestCode) {
    return NextResponse.json({
      success: true,
      message: "No verification code on file",
      data: { emailVerified: false, resendCooldownUntil: null, retryAfter: 0 },
    });
  }

  const now = new Date();
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil(
      (latestCode.resendCooldownUntil.getTime() - now.getTime()) / 1000
    )
  );

  return NextResponse.json({
    success: true,
    message: "Resend cooldown status",
    data: {
      emailVerified: false,
      resendCooldownUntil: latestCode.resendCooldownUntil.toISOString(),
      retryAfter: retryAfterSeconds,
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  // ---- CSRF check ----
  const csrfValid = await validateCsrfToken(request);
  if (!csrfValid) {
    return NextResponse.json(
      { success: false, message: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  // ---- Session check ----
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  if (sessionData.user.emailVerified) {
    return NextResponse.json({
      success: true,
      message: "Email already verified",
    });
  }

  const userEmail = sessionData.user.email;

  // ---- Rate limit check (Requirement 5) ----
  const rateLimit = await checkRateLimit(userEmail, "resend");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many resend requests. Please try again later.",
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

  // ---- Server-side cooldown check (Requirement 6) ----
  // This is the primary resend gate — checked against a DB timestamp, not a
  // client-side disabled button. The client countdown is cosmetic only.
  const latestCode = await prisma.verificationCode.findFirst({
    where: {
      userId: sessionData.user.id,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  const now = new Date();

  if (
    latestCode &&
    latestCode.resendCooldownUntil.getTime() > now.getTime()
  ) {
    const retryAfterSeconds = Math.ceil(
      (latestCode.resendCooldownUntil.getTime() - now.getTime()) / 1000
    );

    // Record this as a failed attempt for rate limiting — aggressive resend
    // hammering will eventually trigger exponential backoff.
    await recordFailedAttempt(userEmail, "resend");

    return NextResponse.json(
      {
        success: false,
        message: "Please wait before requesting a new code.",
        retryAfter: retryAfterSeconds,
        resendCooldownUntil: latestCode.resendCooldownUntil.toISOString(),
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSeconds),
        },
      }
    );
  }

  // ---- Remove previous pending code so only one valid code exists ----
  // The old code is deleted (it was temporary data); the fresh code below is
  // the only valid one, matching the "kept temporarily, removed once no longer
  // needed" lifecycle.
  if (latestCode) {
    await prisma.verificationCode.delete({
      where: { id: latestCode.id },
    });
  }

  // ---- Generate new code ----
  const { code, codeHash } = await generateVerificationCode();

  const newCooldownUntil = new Date(now.getTime() + RESEND_COOLDOWN_MS);

  await prisma.verificationCode.create({
    data: {
      userId: sessionData.user.id,
      codeHash,
      expiresAt: new Date(now.getTime() + VERIFICATION_CODE_TTL_MS),
      resendCooldownUntil: newCooldownUntil,
    },
  });

  // ---- Send email ----
  try {
    await sendVerificationEmail(
      userEmail,
      code,
      sessionData.user.fullName
    );
  } catch (error) {
    console.error("Resend code: failed to send verification email:", error);
  }

  return NextResponse.json({
    success: true,
    message: "A new verification code has been sent to your email.",
    data: {
      resendCooldownUntil: newCooldownUntil.toISOString(),
      retryAfter: RESEND_COOLDOWN_MS / 1000,
    },
  });
}
