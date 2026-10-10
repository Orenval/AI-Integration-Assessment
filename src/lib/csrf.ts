// =============================================================================
// CSRF Protection — Double-Submit Cookie Pattern
// =============================================================================
// Requirement 15: Protect all state-changing endpoints against CSRF.
//
// How it works:
// 1. Server generates a random CSRF token and sets it as a non-HttpOnly cookie
//    (readable by JavaScript on the same origin).
// 2. Client reads the cookie and sends the token value as an X-CSRF-Token header
//    on every state-changing (POST) request.
// 3. Server middleware compares the header value to the cookie value; rejects
//    the request if they don't match.
//
// Why this is secure:
// - A cross-origin attacker can trigger the browser to SEND cookies, but cannot
//   READ cookies from the target domain (same-origin policy). So the attacker
//   cannot construct the X-CSRF-Token header.
// - Combined with SameSite=Strict on the session cookie, cross-site POST requests
//   won't even carry the session cookie.
//
// Why double-submit instead of synchronizer token?
// - Stateless: no server-side storage needed for CSRF tokens.
// - Works well with SPA-style flows where the client manages form submissions.
// - Simpler to implement in a Next.js API route architecture.
//
// SameSite=Strict justification:
// - This app never sends internal links in email (verify/reset flows use
//   codes typed in-app), so no flow relies on a cookie arriving via a
//   top-level navigation from an external origin. Strict therefore blocks the
//   cookie on ALL cross-site requests — the safest setting — with no UX cost.
// - The double-submit pattern provides an additional layer on top of SameSite.

import crypto from "crypto";
import { cookies } from "next/headers";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Generate a new CSRF token and set it as a cookie.
 * The cookie is NOT HttpOnly so client-side JavaScript can read it.
 *
 * @returns The generated CSRF token string.
 */
export async function generateCsrfToken(): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");

  const cookieStore = await cookies();
  cookieStore.set(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Must be readable by client JS
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60, // 1 hour — re-generated on each page load
  });

  return token;
}

/**
 * Validate a CSRF token from the request headers against the cookie value.
 *
 * @param request - The incoming Request object.
 * @returns true if the CSRF token is valid, false otherwise.
 */
export async function validateCsrfToken(request: Request): Promise<boolean> {
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get(CSRF_COOKIE_NAME)?.value;

  // Both must exist and match
  if (!headerToken || !cookieToken) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks on the token value
  if (headerToken.length !== cookieToken.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(headerToken),
    Buffer.from(cookieToken)
  );
}
