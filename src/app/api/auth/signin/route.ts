// =============================================================================
// POST /api/auth/signin — User Sign In
// =============================================================================
// Requirements addressed:
// - Req 5:  Rate limiting with exponential backoff
// - Req 7:  Account enumeration prevention — generic errors, timing-safe
// - Req 15: CSRF validation

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { signInSchema } from "@/lib/validation";
import { verifyPassword, DUMMY_PASSWORD_HASH } from "@/lib/password";
import { createSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
} from "@/lib/rate-limit";

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

  const validation = signInSchema.safeParse(body);
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

  const { email, password } = validation.data;
  const normalizedEmail = email.toLowerCase().trim();

  // ---- Rate limit check (Requirement 5) ----
  const rateLimit = await checkRateLimit(normalizedEmail, "signin");
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: "Too many sign-in attempts. Please try again later.",
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

  // ---- Look up user ----
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  // ---- Timing-safe comparison (Requirement 7) ----
  // If the user doesn't exist, we still run bcrypt.compare against a dummy
  // hash. This ensures the response time is indistinguishable from a real
  // wrong-password attempt, preventing timing-based account enumeration.
  const passwordToCompare = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordValid = await verifyPassword(password, passwordToCompare);

  if (!user || !passwordValid) {
    // Record failed attempt for rate limiting
    await recordFailedAttempt(normalizedEmail, "signin");

    // Generic error — never reveal whether the email exists (Requirement 7)
    return NextResponse.json(
      { success: false, message: "Invalid email or password" },
      { status: 401 }
    );
  }

  // ---- Success: reset rate limit, create session ----
  await resetRateLimit(normalizedEmail, "signin");
  await createSession(user.id);

  // If the user hasn't verified their email, tell the client to redirect
  // to the verification page
  const requiresVerification = !user.emailVerified;

  return NextResponse.json({
    success: true,
    message: "Signed in successfully",
    data: { requiresVerification },
  });
}
