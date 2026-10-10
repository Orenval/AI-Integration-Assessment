// =============================================================================
// POST /api/auth/verify-email — Email Verification
// =============================================================================
// Requirements addressed:
// - Req 11: Code expiry checked server-side against DB expiresAt
// - Req 15: CSRF validation

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyEmailSchema } from "@/lib/validation";
import { validateSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import { hashCode, MAX_CODE_ATTEMPTS } from "@/lib/verification";
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
    return NextResponse.json(
      { success: false, message: "No pending verification code. Please request a new one." },
      { status: 400 }
    );
  }

  // ---- Check attempt lockout ----
  if (verificationCode.attemptCount >= MAX_CODE_ATTEMPTS) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many incorrect attempts. Please request a new code.",
      },
      { status: 429 }
    );
  }

  // ---- Check expiry (Requirement 11: DB-enforced, not just UI countdown) ----
  const now = new Date();
  if (verificationCode.expiresAt.getTime() < now.getTime()) {
    return NextResponse.json(
      {
        success: false,
        message: "Verification code has expired. Please request a new one.",
      },
      { status: 400 }
    );
  }

  // ---- Compare code hashes ----
  const submittedHash = hashCode(code);
  if (submittedHash !== verificationCode.codeHash) {
    // Increment attempt counter
    await prisma.verificationCode.update({
      where: { id: verificationCode.id },
      data: { attemptCount: { increment: 1 } },
    });

    const remainingAttempts =
      MAX_CODE_ATTEMPTS - (verificationCode.attemptCount + 1);
    return NextResponse.json(
      {
        success: false,
        message: `Incorrect verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`,
      },
      { status: 400 }
    );
  }

  // ---- Success: delete the verification code (it is temporary data that must
  // be removed once the email is verified) and mark the user verified ----
  await prisma.$transaction([
    prisma.verificationCode.delete({
      where: { id: verificationCode.id },
    }),
    prisma.user.update({
      where: { id: sessionData.user.id },
      data: { emailVerified: true },
    }),
  ]);

  // ---- Send welcome email — ONLY now, after the server has confirmed the
  // email was verified (account exists, code valid, record deleted) ----
  // A delivery failure is logged but must never break the verification flow.
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
