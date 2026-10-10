// =============================================================================
// Rate Limiting with Exponential Backoff
// =============================================================================
// Requirement 5: Applied to sign-in, sign-up, forgot-password, and resend-code.
// On repeated failures from the same identifier (email or IP), the lockout
// window increases exponentially: 1min → 2min → 4min → 8min → 16min → 32min →
// 60min (capped).
//
// The backoff curve is 2^(attemptCount - 1) minutes, capped at 60 minutes.
// This balances user friction (a single typo causes only a 1-minute lockout
// after 3 attempts) against brute-force deterrence (10 consecutive failures
// produce a 1-hour lockout).
//
// Why database-backed instead of in-memory (e.g. a Map or Redis)?
// - Survives server restarts and serverless cold starts (critical for Next.js
//   deployed on Vercel or similar platforms where each request may hit a
//   different isolate).
// - Shares state across all server instances.
// - Trade-off: slightly higher latency per check (~1 DB query). Acceptable for
//   auth endpoints which are already I/O-bound by bcrypt.
//
// The lockout is applied BEFORE the business logic runs, so a locked-out
// attacker doesn't even trigger a bcrypt comparison or email lookup.

import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Number of failed attempts before any lockout kicks in.
 * The first 2 failures are free; the 3rd triggers a 1-minute lockout.
 */
const FREE_ATTEMPTS = 2;

/** Maximum lockout duration in minutes (cap on the exponential curve). */
const MAX_LOCKOUT_MINUTES = 60;

/**
 * Window after which the attempt counter resets to zero (in milliseconds).
 * If a user hasn't triggered a failure in 2 hours, their slate is clean.
 */
const WINDOW_RESET_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /** Seconds until the lockout expires (present only when blocked). */
  retryAfter?: number;
}

/**
 * Check whether a request from the given identifier on the given route is
 * currently rate-limited.
 *
 * @param identifier - The email address or IP address.
 * @param route - The route key (e.g. "signin", "signup", "forgot-password", "resend").
 * @returns Whether the request is allowed, and if not, how long to wait.
 */
export async function checkRateLimit(
  identifier: string,
  route: string
): Promise<RateLimitResult> {
  const now = new Date();

  const record = await prisma.rateLimitAttempt.findUnique({
    where: { identifier_route: { identifier, route } },
  });

  // No record → no previous failures → allowed
  if (!record) {
    return { allowed: true };
  }

  // If the window has expired, reset the counter (next recordFailedAttempt will
  // create a fresh record).
  if (now.getTime() - record.windowStart.getTime() > WINDOW_RESET_MS) {
    await prisma.rateLimitAttempt.delete({
      where: { id: record.id },
    });
    return { allowed: true };
  }

  // If currently locked out, check if the lockout has expired
  if (record.lockedUntil && record.lockedUntil.getTime() > now.getTime()) {
    const retryAfterSeconds = Math.ceil(
      (record.lockedUntil.getTime() - now.getTime()) / 1000
    );
    return { allowed: false, retryAfter: retryAfterSeconds };
  }

  // Not locked → allowed
  return { allowed: true };
}

/**
 * Record a failed attempt and potentially apply a lockout.
 *
 * The lockout duration follows an exponential curve:
 *   lockout = min(2^(attempts - FREE_ATTEMPTS - 1), MAX_LOCKOUT_MINUTES) minutes
 *
 * Examples (with FREE_ATTEMPTS = 2):
 *   Attempt 1: no lockout (free)
 *   Attempt 2: no lockout (free)
 *   Attempt 3: 1 minute lockout  (2^0 = 1)
 *   Attempt 4: 2 minute lockout  (2^1 = 2)
 *   Attempt 5: 4 minute lockout  (2^2 = 4)
 *   Attempt 6: 8 minute lockout  (2^3 = 8)
 *   ...
 *   Attempt 10+: 60 minute lockout (capped)
 *
 * @param identifier - The email address or IP address.
 * @param route - The route key.
 */
export async function recordFailedAttempt(
  identifier: string,
  route: string
): Promise<void> {
  const now = new Date();

  const record = await prisma.rateLimitAttempt.upsert({
    where: { identifier_route: { identifier, route } },
    update: {
      attemptCount: { increment: 1 },
    },
    create: {
      identifier,
      route,
      attemptCount: 1,
      windowStart: now,
    },
  });

  const attempts = record.attemptCount;

  // Only apply lockout after FREE_ATTEMPTS
  if (attempts > FREE_ATTEMPTS) {
    const exponent = attempts - FREE_ATTEMPTS - 1;
    const lockoutMinutes = Math.min(
      Math.pow(2, exponent),
      MAX_LOCKOUT_MINUTES
    );
    const lockedUntil = new Date(now.getTime() + lockoutMinutes * 60 * 1000);

    await prisma.rateLimitAttempt.update({
      where: { id: record.id },
      data: { lockedUntil },
    });
  }
}

/**
 * Reset the rate limit for an identifier on a given route.
 * Called on successful authentication to clear the failure counter.
 *
 * @param identifier - The email address or IP address.
 * @param route - The route key.
 */
export async function resetRateLimit(
  identifier: string,
  route: string
): Promise<void> {
  await prisma.rateLimitAttempt.deleteMany({
    where: { identifier, route },
  });
}
