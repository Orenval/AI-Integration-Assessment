// =============================================================================
// Session Management
// =============================================================================
// Requirement 3: Both idle timeout (30 min inactivity) and absolute timeout
//                (24 h from creation) are enforced on every authenticated request.
// Requirement 8: Sign-out sets invalidatedAt (server-side invalidation).
//                Password reset invalidates ALL sessions for the user.
// Requirement 9: Session record stores only id, userId, tokenHash, timestamps.
//                No full user objects or sensitive data in the session or cookie.

import crypto from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name for the session token. */
export const SESSION_COOKIE_NAME = "session_token";

/** Idle timeout: session expires after 30 minutes of inactivity. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Absolute timeout: session expires 24 hours after creation, regardless. */
const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/**
 * Hash a raw session token with SHA-256 before storing in the database.
 * If the database is compromised, the attacker gets hashes — not usable tokens.
 */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session for the given user.
 *
 * Generates a 32-byte cryptographically random token, stores its SHA-256 hash
 * in the database, and sets the raw token as an HttpOnly cookie.
 *
 * @returns The raw session token (for the cookie) — never stored server-side.
 */
export async function createSession(userId: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  await prisma.session.create({
    data: {
      userId,
      sessionTokenHash: tokenHash,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS),
    },
  });

  // Set the session cookie
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    // Secure flag: true in production (HTTPS), false in dev (HTTP).
    secure: process.env.NODE_ENV === "production",
    // SameSite=Strict: the cookie is never sent on any cross-site request,
    // including top-level navigations from external links. This app does not
    // send clickable links to internal routes in email (reset/verify flows use
    // codes typed in-app), so Strict cannot break those flows.
    // Combined with CSRF double-submit pattern, this provides robust
    // protection (Requirement 15).
    sameSite: "strict",
    path: "/",
    // Cookie maxAge matches the absolute timeout. The server still enforces
    // both idle and absolute timeouts independently.
    maxAge: ABSOLUTE_TIMEOUT_MS / 1000,
  });

  return rawToken;
}

/**
 * Validate the current session from the cookie.
 *
 * Checks:
 * 1. Cookie exists and contains a token
 * 2. Token hash matches a session in the database
 * 3. Session has not been invalidated (sign-out)
 * 4. Absolute timeout has not passed (expiresAt)
 * 5. Idle timeout has not passed (lastActivityAt + 30min)
 *
 * On success, updates lastActivityAt to "touch" the session (reset idle timer).
 *
 * @returns The session and associated user, or null if invalid.
 */
export async function validateSession(): Promise<{
  session: { id: string; userId: string };
  user: { id: string; fullName: string; email: string; emailVerified: boolean };
} | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!rawToken) {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const session = await prisma.session.findUnique({
    where: { sessionTokenHash: tokenHash },
    include: {
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          emailVerified: true,
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // Check 1: Not invalidated (sign-out sets this field)
  if (session.invalidatedAt !== null) {
    return null;
  }

  // Check 2: Absolute timeout — 24h ceiling from creation
  if (session.expiresAt.getTime() < now.getTime()) {
    return null;
  }

  // Check 3: Idle timeout — 30min since last activity
  if (session.lastActivityAt.getTime() + IDLE_TIMEOUT_MS < now.getTime()) {
    return null;
  }

  // Touch: update lastActivityAt to reset the idle timer.
  // This is a fire-and-forget update — we don't await it to avoid blocking
  // the response, but we do want it to persist.
  await prisma.session.update({
    where: { id: session.id },
    data: { lastActivityAt: now },
  });

  return {
    session: { id: session.id, userId: session.userId },
    user: session.user,
  };
}

/**
 * Invalidate a single session (sign-out).
 * Sets invalidatedAt to the current timestamp; subsequent validateSession()
 * calls will reject this session. The cookie is also cleared.
 *
 * Requirement 8: Server-side invalidation — not just clearing the client cookie.
 */
export async function invalidateSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { invalidatedAt: new Date() },
  });

  // Also clear the cookie so the client stops sending it.
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0, // Immediately expires the cookie
  });
}

/**
 * Invalidate ALL sessions for a user.
 * Called on password reset (Requirement 8) to ensure that stolen sessions
 * from before the password change are no longer valid.
 */
export async function invalidateAllUserSessions(
  userId: string
): Promise<void> {
  await prisma.session.updateMany({
    where: {
      userId,
      invalidatedAt: null, // Only invalidate active sessions
    },
    data: { invalidatedAt: new Date() },
  });
}
