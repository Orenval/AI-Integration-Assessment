// =============================================================================
// Password Reset Code Generation & Validation
// =============================================================================
// Requirement 12: Single-use and time-limited.
//
// The password reset credential is a 6-digit numeric code — generated exactly
// like the email verification code (crypto.randomBytes(32) reduced to 6 digits,
// see src/lib/verification.ts). Only the SHA-256 hash is stored in the
// database, so a database breach does not expose valid reset codes. The raw
// code is sent to the user's email and never persisted.
//
// Code expiry: 1 hour. Long enough for a user to check their email and
// complete the reset, but short enough to limit the attack window if the email
// is compromised.
//
// Resend cooldown: 60 seconds, stored as resendCooldownUntil in the database
// and enforced server-side (requesting a new code before the window elapses is
// silently skipped — the response stays identical to preserve anti-enumeration).
//
// Max attempts: 5 wrong codes before the code is locked out (mirrors the email
// verification flow).
//
// Single-use enforcement: The row is DELETED immediately when the code is
// consumed (reset-password), matching the VerificationCode lifecycle. The
// `usedAt` column is a deprecated soft-mark retained for schema stability; it
// only ever holds a value on legacy rows. To prevent accumulation, expired,
// never-used rows are deleted by the per-user cleanup in forgot-password and by
// the hourly sweeper registered in src/instrumentation.ts.

import { prisma } from "./prisma";
import { generateVerificationCode, hashCode } from "./verification";

/** How long a password reset code remains valid (milliseconds). */
export const RESET_CODE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/** Minimum time between reset code requests (milliseconds). */
export const RESET_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/** Maximum wrong-code attempts before lockout. */
export const MAX_RESET_CODE_ATTEMPTS = 5;

/**
 * Generate a 6-digit password reset code and its SHA-256 hash.
 *
 * Reuses the exact generation strategy as the email verification code:
 * crypto.randomBytes(32) reduced mod 10^6, zero-padded to 6 digits.
 *
 * @returns An object with:
 *   - `code`: the 6-digit string (to be emailed to the user)
 *   - `codeHash`: the SHA-256 hex digest (to be stored in the database)
 */
export const generateResetCode = generateVerificationCode;

/**
 * Hash a password reset code with SHA-256 for storage or comparison.
 *
 * @param code - The 6-digit code string.
 * @returns The SHA-256 hex digest.
 */
export const hashResetCode = hashCode;

/**
 * Delete password reset tokens that expired without ever being used.
 *
 * Rows are deleted (not soft-marked) so truly expired, never-used tokens do not
 * accumulate. Scope to one user by passing `userId`, or sweep globally by
 * omitting it. deleteMany is idempotent, so concurrent sweeps from multiple
 * server instances are safe.
 *
 * @param userId - Optional. When provided, only that user's rows are deleted.
 * @returns The number of rows deleted.
 */
export async function cleanupExpiredResetTokens(
  userId?: string
): Promise<number> {
  const result = await prisma.passwordResetToken.deleteMany({
    where: {
      usedAt: null,
      expiresAt: { lt: new Date() },
      ...(userId ? { userId } : {}),
    },
  });
  return result.count;
}