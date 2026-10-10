// =============================================================================
// POST /api/auth/signup — User Registration
// =============================================================================
// Requirements addressed:
// - Req 1:  Password strength validated via shared Zod schema
// - Req 2:  Server-side validation is the source of truth (client reuses schema)
// - Req 4:  bcrypt cost factor 10 for password hashing
// - Req 5:  Rate limiting with exponential backoff
// - Req 7:  Account enumeration prevention — same response shape on email conflict
// - Req 13: Unique email constraint enforced at DB level
// - Req 14: Idempotency — unique constraint handles double submissions cleanly
// - Req 15: CSRF token validation on POST

import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { signUpSchema } from "@/lib/validation";
import { hashPassword, verifyPassword } from "@/lib/password";
import { createSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import { checkRateLimit, recordFailedAttempt } from "@/lib/rate-limit";
import {
  generateVerificationCode,
  CODE_EXPIRY_MS,
  RESEND_COOLDOWN_MS,
} from "@/lib/verification";
import { sendVerificationEmail } from "@/lib/email";

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

  const validation = signUpSchema.safeParse(body);
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

  const { fullName, email, password } = validation.data;
  const normalizedEmail = email.toLowerCase().trim();

  // ---- Rate limit check ----
  const rateLimit = await checkRateLimit(normalizedEmail, "signup");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many signup attempts. Please try again later.",
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

  // ---- Hash password ----
  const passwordHash = await hashPassword(password);

  // ---- Create user ----
  try {
    const user = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: normalizedEmail,
        passwordHash,
      },
    });

    // ---- Generate verification code ----
    // Sets resendCooldownUntil = now + RESEND_COOLDOWN_MS (60s) on FIRST
    // creation, so the resend button on the verification screen is correctly
    // disabled from the moment that screen loads — no resend attempt needed.
    // See "Resend cooldown, enforced server-side" in src/lib/verification.ts.
    const now = new Date();
    const { code, codeHash } = generateVerificationCode();

    await prisma.verificationCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(now.getTime() + CODE_EXPIRY_MS),
        resendCooldownUntil: new Date(now.getTime() + RESEND_COOLDOWN_MS),
      },
    });

    // ---- Send verification email (must NOT block account creation) ----
    // The account and verification code are already persisted; a transient
    // SMTP failure is logged and swallowed so registration still succeeds.
    // The welcome email is NOT sent here — it goes out only after the email
    // has been verified (see /api/auth/verify-email).
    try {
      await sendVerificationEmail(normalizedEmail, code, fullName.trim());
    } catch (error) {
      console.error("Signup: failed to send verification email:", error);
    }

    // ---- Create session (unverified user, will be redirected to verify) ----
    await createSession(user.id);

    return NextResponse.json(
      {
        success: true,
        message: "Account created. Please verify your email.",
        data: { requiresVerification: true },
      },
      { status: 201 }
    );
  } catch (error) {
    // ---- Handle unique constraint violation (Requirement 14: idempotency) ----
    // Requirement 7: Same response shape to prevent enumeration.
    // An attacker cannot distinguish "new account created" from "email already
    // exists" because we return the same HTTP status and message shape.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // Record a failed attempt for rate limiting purposes — an attacker
      // probing emails via signup will eventually get rate-limited.
      await recordFailedAttempt(normalizedEmail, "signup");

      // The account already exists. To keep responses identical (Requirement 7)
      // we still return the same 201 success shape, BUT:
      //  - If the submitted password matches the existing account, this is a
      //    legitimate idempotent double-submit (e.g. the owner re-submitted the
      //    form after a refresh). Complete the flow properly: issue a fresh
      //    verification code, email it, and create a session — so the user is
      //    signed in and lands on the verification screen instead of being
      //    bounced to /signin. We only send the email when the password is
      //    correct, so an attacker probing existing emails cannot spam victims.
      //  - If the password does not match, return the identical success shape
      //    with NO email, no code, and no session. The client then redirects
      //    to /verify-email (a protected route) and the middleware sends the
      //    user to /signin — exactly where a stranger should end up.
      const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      let passwordMatches = false;
      if (existingUser) {
        passwordMatches = await verifyPassword(
          password,
          existingUser.passwordHash
        );
      }

      if (existingUser && passwordMatches) {
        const now = new Date();
        const { code, codeHash } = generateVerificationCode();

        await prisma.verificationCode.create({
          data: {
            userId: existingUser.id,
            codeHash,
            expiresAt: new Date(now.getTime() + CODE_EXPIRY_MS),
            resendCooldownUntil: new Date(now.getTime() + RESEND_COOLDOWN_MS),
          },
        });

        await sendVerificationEmail(
          normalizedEmail,
          code,
          existingUser.fullName
        );

        await createSession(existingUser.id);
      }

      return NextResponse.json(
        {
          success: true,
          message: "Account created. Please verify your email.",
          data: { requiresVerification: true },
        },
        { status: 201 }
      );
    }

    console.error("Signup error:", error);
    return NextResponse.json(
      { success: false, message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
