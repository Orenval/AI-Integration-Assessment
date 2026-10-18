// =============================================================================
// POST /api/auth/verify-email — Email Verification
// =============================================================================
// Requirements addressed:
// - Req 11: Code expiry checked server-side against DB expiresAt
// - Req 15: CSRF validation
// - bcrypt comparison with atomic attempt reservation and lockout at 5 attempts
// - Uniform timing via dummy hash comparison when row is inactive

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyEmailSchema } from "@/lib/validation";
import { validateSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import {
  compareCode,
  DUMMY_CODE_HASH,
  MAX_CODE_ATTEMPTS,
} from "@/lib/verification";
import { sendWelcomeEmail } from "@/lib/email";

export async function POST(request: Request): Promise<NextResponse> {
  // ---- CSRF check ----
  const csrfValid = await validateCsrfToken(request);
  if (!csrfValid) {
    return NextResponse.json(
      { success: false, message: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  // ---- Session check (user must be logged in after signup) ----
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  // ---- Already verified? ----
  if (sessionData.user.emailVerified) {
    return NextResponse.json({
      success: true,
      message: "Email already verified",
    });
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

  const validation = verifyEmailSchema.safeParse(body);
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

  const { code } = validation.data;

  // ---- Find the latest unconsumed verification code for this user ----
  const verificationCode = await prisma.verificationCode.findFirst({
    where: {
      userId: sessionData.user.id,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!verificationCode) {
    await compareCode(code, DUMMY_CODE_HASH);
    return NextResponse.json(
      { success: false, message: "No pending verification code. Please request a new one." },
      { status: 400 }
    );
  }

  const now = new Date();

  // ---- Check expiry (Requirement 11) ----
  if (verificationCode.expiresAt.getTime() <= now.getTime()) {
    await compareCode(code, DUMMY_CODE_HASH);
    return NextResponse.json(
      {
        success: false,
        message: "That code has expired. Request a new one.",
        expired: true,
      },
      { status: 400 }
    );
  }

  // ---- Check attempt lockout ----
  if (verificationCode.attemptCount >= MAX_CODE_ATTEMPTS) {
    await compareCode(code, DUMMY_CODE_HASH);
    return NextResponse.json(
      {
        success: false,
        message: "Too many incorrect attempts. Please request a new code.",
      },
      { status: 429 }
    );
  }

  // ---- Reserve an attempt before comparing (Step 3: atomic reservation) ----
  const reserveResult = await prisma.verificationCode.updateMany({
    where: {
      id: verificationCode.id,
      attemptCount: { lt: MAX_CODE_ATTEMPTS },
      expiresAt: { gt: now },
    },
    data: {
      attemptCount: { increment: 1 },
    },
  });

  if (reserveResult.count === 0) {
    const current = await prisma.verificationCode.findUnique({
      where: { id: verificationCode.id },
    });
    if (!current || current.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json(
        {
          success: false,
          message: "That code has expired. Request a new one.",
          expired: true,
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        success: false,
        message: "Too many incorrect attempts. Please request a new code.",
      },
      { status: 429 }
    );
  }

  // ---- Check expiry again in code ----
  if (verificationCode.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json(
      {
        success: false,
        message: "That code has expired. Request a new one.",
        expired: true,
      },
      { status: 400 }
    );
  }

  // ---- Compare code hashes with bcrypt ----
  const isValid = await compareCode(code, verificationCode.codeHash);
  if (!isValid) {
    const updatedCode = await prisma.verificationCode.findUnique({
      where: { id: verificationCode.id },
      select: { attemptCount: true },
    });
    const currentAttempts =
      updatedCode?.attemptCount ?? (verificationCode.attemptCount + 1);
    const remainingAttempts = Math.max(0, MAX_CODE_ATTEMPTS - currentAttempts);

    return NextResponse.json(
      {
        success: false,
        message: `Incorrect verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`,
      },
      { status: 400 }
    );
  }

  // ---- Success: delete the verification code and mark user verified ----
  await prisma.$transaction([
    prisma.verificationCode.delete({
      where: { id: verificationCode.id },
    }),
    prisma.user.update({
      where: { id: sessionData.user.id },
      data: { emailVerified: true },
    }),
  ]);

  // ---- Send welcome email ----
  try {
    await sendWelcomeEmail(
      sessionData.user.email,
      sessionData.user.fullName
    );
  } catch (error) {
    console.error("Verify email: failed to send welcome email:", error);
  }

  return NextResponse.json({
    success: true,
    message: "Email verified successfully",
  });
}
