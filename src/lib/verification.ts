// =============================================================================
// Verification Code Generation & Validation
// =============================================================================
// Generates a 6-digit numeric verification code from crypto.randomBytes(32).
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
// Mod bias analysis:
// The range of a 256-bit integer is [0, 2^256 - 1]. We're reducing mod 10^6.
// The bias is (2^256 mod 10^6) / 2^256 ≈ 10^6 / 2^256 ≈ 10^(-71).
// This is astronomically small — far below any practical threshold. The bias
// from using a shorter byte source (e.g. 4 bytes = 2^32) would be larger
// (2^32 mod 10^6 / 2^32 ≈ 0.07%), which is still negligible but less clean.
// 32 bytes gives us zero practical bias and aligns with the spec requirement.
//
// Security note: Only the SHA-256 hash of the code is stored in the database.
// The raw code is sent to the user's email and never persisted server-side.
// This means a database breach does not expose valid verification codes.
//
// Code expiry: 10 minutes (stored as expiresAt in the database).
// Resend cooldown: 60 seconds (stored as resendCooldownUntil in the database).
// Max attempts: 5 wrong codes before the code is locked out.
//
// Resend cooldown, enforced server-side:
// ---------------------------------------------------------------------------
// This is the single source of truth for the 60-second resend window. Every
// verification code created (signup) or resent (POST /api/auth/resend-code)
// stamps resendCooldownUntil = now + RESEND_COOLDOWN_MS in the database.
// The client countdown on the verification screen is a cosmetic reflection of
// that timestamp — page refreshes and multiple tabs all re-sync to the same
// DB value, and a manual resend attempt before the window elapses returns
// HTTP 429 with the remaining seconds (see src/app/api/auth/resend-code/route.ts).

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a verification code remains valid (milliseconds). */
export const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/** Minimum time between resend requests (milliseconds). */
export const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

/** Maximum wrong-code attempts before lockout. */
export const MAX_CODE_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a 6-digit verification code and its SHA-256 hash.
 *
 * @returns An object with:
 *   - `code`: the 6-digit string (to be emailed to the user)
 *   - `codeHash`: the SHA-256 hex digest (to be stored in the database)
 */
export function generateVerificationCode(): {
  code: string;
  codeHash: string;
} {
  // Step 1: Generate 32 bytes of cryptographic randomness
  const randomBytes = crypto.randomBytes(32);

  // Step 2: Interpret as a BigInt (unsigned, big-endian)
  const bigIntValue = BigInt("0x" + randomBytes.toString("hex"));

  // Step 3: Reduce mod 10^6 to get a number in [0, 999999]
  const sixDigitNumber = bigIntValue % BigInt(1_000_000);

  // Step 4: Zero-pad to exactly 6 digits
  const code = sixDigitNumber.toString().padStart(6, "0");

  // Step 5: Hash for storage — never store the raw code
  const codeHash = hashCode(code);

  return { code, codeHash };
}

/**
 * Hash a verification code with SHA-256 for storage or comparison.
 *
 * @param code - The 6-digit code string.
 * @returns The SHA-256 hex digest.
 */
export function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}
