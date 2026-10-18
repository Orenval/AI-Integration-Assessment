// =============================================================================
// Verification Code Generation & Validation
// =============================================================================
// Generates a 6-digit numeric verification code from crypto.randomBytes(32).
// Hashed using bcrypt with cost factor 10 (matching password hashing).
//
// Why crypto.randomBytes(32) reduced to 6 digits?
// ---------------------------------------------------------------------------
// We need a code that is:
// 1. Cryptographically random (unpredictable to an attacker)
// 2. Short enough for a user to type from their email (6 digits)
// 3. Derived from a high-entropy source (not Math.random())
//
// The approach:
// - Generate 32 bytes (256 bits) of cryptographic randomness.
// - Interpret the bytes as a BigInt (a 256-bit unsigned integer).
// - Take mod 10^6 to reduce it to a number in [0, 999999].
// - Zero-pad to 6 digits (e.g. 42 → "000042").
//
// Security note: Only the bcrypt hash of the code is stored in the database.
// The raw code is sent to the user's email and never persisted server-side.
// bcrypt hashes are salted, so candidate codes are verified using compareCode.
//
// Code expiry: 60 seconds (VERIFICATION_CODE_TTL_MS).
// Resend cooldown: 60 seconds (stored as resendCooldownUntil in the database).
// Max attempts: 5 wrong codes before the code is locked out.

import crypto from "crypto";
import bcrypt from "bcrypt";
import { prisma } from "./prisma";
import { COST_FACTOR, DUMMY_PASSWORD_HASH } from "./password";
import { VERIFICATION_CODE_TTL_MS } from "./auth-config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a verification code remains valid (milliseconds). */
export const CODE_EXPIRY_MS = VERIFICATION_CODE_TTL_MS;

/** Minimum time between resend requests (milliseconds). */
export const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/** Maximum wrong-code attempts before lockout. */
export const MAX_CODE_ATTEMPTS = 5;

/** Fixed dummy bcrypt hash used to equalize timing on non-existent accounts. */
export const DUMMY_CODE_HASH = DUMMY_PASSWORD_HASH;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a 6-digit verification code and its bcrypt hash.
 *
 * @returns An object with:
 *   - `code`: the 6-digit string (to be emailed to the user)
 *   - `codeHash`: the bcrypt hash string (to be stored in the database)
 */
export async function generateVerificationCode(): Promise<{
  code: string;
  codeHash: string;
}> {
  // Step 1: Generate 32 bytes of cryptographic randomness
  const randomBytes = crypto.randomBytes(32);

  // Step 2: Interpret as a BigInt (unsigned, big-endian)
  const bigIntValue = BigInt("0x" + randomBytes.toString("hex"));

  // Step 3: Reduce mod 10^6 to get a number in [0, 999999]
  const sixDigitNumber = bigIntValue % BigInt(1_000_000);

  // Step 4: Zero-pad to exactly 6 digits
  const code = sixDigitNumber.toString().padStart(6, "0");

  // Step 5: Hash for storage with bcrypt — never store the raw code
  const codeHash = await hashCode(code);

  return { code, codeHash };
}

/**
 * Hash a verification code with bcrypt (cost factor 10) for storage or comparison.
 *
 * @param code - The 6-digit code string.
 * @returns The bcrypt hash string.
 */
export async function hashCode(code: string): Promise<string> {
  const cost = COST_FACTOR || 10;
  return bcrypt.hash(code, cost);
}

/**
 * Compare a plaintext verification code against a bcrypt hash.
 * Uses bcrypt's constant-time comparison to avoid timing side-channels.
 *
 * @param code - The candidate 6-digit code string.
 * @param hash - The stored bcrypt hash.
 * @returns true if the code matches, false otherwise.
 */
export async function compareCode(
  code: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

/**
 * Delete verification codes that expired without being consumed.
 *
 * Rows are deleted (not soft-marked) so truly expired, never-used codes do not
 * accumulate. Scope to one user by passing `userId`, or sweep globally by
 * omitting it.
 *
 * @param userId - Optional. When provided, only that user's rows are deleted.
 * @returns The number of rows deleted.
 */
export async function cleanupExpiredVerificationCodes(
  userId?: string
): Promise<number> {
  const result = await prisma.verificationCode.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
      ...(userId ? { userId } : {}),
    },
  });
  return result.count;
}
