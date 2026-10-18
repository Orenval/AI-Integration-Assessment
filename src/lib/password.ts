// =============================================================================
// Password Hashing — bcrypt with cost factor 10
// =============================================================================
// Requirement 4: bcrypt handles salt generation internally per password.
// The salt is embedded in the bcrypt output string, so we never need to store
// or manage salts separately.
//
// Why cost factor 10?
// ---------------------------------------------------------------------------
// bcrypt's cost factor is a power-of-two work parameter: cost 10 means 2^10
// (1,024) rounds of the Blowfish key schedule. Each increment doubles the
// computation time.
//
// - Cost 10 produces a hash in roughly 50–100ms on modern hardware. This is
//   imperceptible to a user logging in but forces an attacker running an
//   offline brute-force attack to spend ~100ms per candidate password.
//   At scale, that's ~10 passwords/sec per core — making dictionary attacks
//   prohibitively slow.
//
// - Cost 12 (~200–400ms) would be safer against future hardware but risks
//   noticeable login latency under load and hurts serverless cold-start times.
//   For this application's threat model (not a bank, not storing PII beyond
//   name/email), cost 10 is the standard OWASP recommendation.
//
// - Cost 8 (~12ms) is too cheap — a stolen database could be cracked at
//   thousands of hashes/sec on a modern GPU cluster.
//
// Alternatives considered:
// - Argon2id: memory-hard, superior resistance to GPU/ASIC attacks. Not chosen
//   because bcrypt is explicitly required by the spec, but Argon2id would be
//   the author's first choice for a greenfield project in 2024+.
// - scrypt: also memory-hard, but less widely audited than Argon2id.
// - PBKDF2: CPU-bound only (no memory hardness), weaker than bcrypt against
//   GPU attacks. Not recommended.
// ---------------------------------------------------------------------------

import bcrypt from "bcrypt";

export const COST_FACTOR = 10;

/**
 * Hash a plaintext password using bcrypt with cost factor 10.
 * The salt is generated internally by bcrypt and embedded in the output.
 *
 * @param plainPassword - The user's plaintext password (never logged or stored).
 * @returns The bcrypt hash string (e.g. "$2b$10$...").
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, COST_FACTOR);
}

/**
 * Compare a plaintext password against a bcrypt hash.
 * Uses bcrypt's constant-time comparison to avoid timing side-channels.
 *
 * @param plainPassword - The candidate password.
 * @param hash - The stored bcrypt hash.
 * @returns true if the password matches, false otherwise.
 */
export async function verifyPassword(
  plainPassword: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plainPassword, hash);
}

/**
 * A pre-computed bcrypt hash used as a dummy target when a user lookup fails.
 * This ensures that sign-in for a non-existent email still runs bcrypt.compare,
 * so the response time is indistinguishable from a real (wrong-password) attempt.
 * This prevents timing-based account enumeration (Requirement 7).
 *
 * The actual password behind this hash is irrelevant — comparison will always
 * fail, which is the desired behavior.
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012";
