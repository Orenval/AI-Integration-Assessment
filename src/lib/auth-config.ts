// =============================================================================
// Authentication TTL & Expiry Configuration
// =============================================================================
// Central configuration for time-to-live (TTL) limits on authentication
// credentials (verification codes and password reset tokens).

/**
 * How long an email verification code remains valid (milliseconds).
 * Lives for 60 seconds (1 minute).
 */
export const VERIFICATION_CODE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * How long a password reset code remains valid (milliseconds).
 * Lives for 10 minutes.
 */
export const RESET_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
