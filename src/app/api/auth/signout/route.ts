// =============================================================================
// POST /api/auth/signout — Sign Out
// =============================================================================
// Requirement 8: Server-side session invalidation — sets invalidatedAt on the
// session record, not just clearing the client cookie.
// Requirement 15: CSRF validation

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  validateSession,
  invalidateSession,
  SESSION_COOKIE_NAME,
} from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";

// ===========================================================================
// GET /api/auth/signout — Clear Stale Session Cookie
// ===========================================================================
// Recovery path for an expired/invalid session: when the page detects a 401
// ("Not authenticated") it calls GET signout so the dead session_token cookie
// is cleared unconditionally, then sends the user to /signin. No CSRF token is
// required (harmless, state-clearing-only) so recovery works even if the CSRF
// cookie has expired too.
export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0, // Immediately expires the cookie
  });

  return NextResponse.json({
    success: true,
    message: "Signed out",
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  // ---- CSRF check ----
  const csrfValid = await validateCsrfToken(request);
  if (!csrfValid) {
    return NextResponse.json(
      { success: false, message: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  // ---- Session check ----
  const sessionData = await validateSession();
  if (!sessionData) {
    // Already signed out or session expired — still clear the stale cookie so
    // the browser doesn't keep sending a cookie for a dead session.
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });

    return NextResponse.json({
      success: true,
      message: "Signed out",
    });
  }

  // ---- Invalidate session server-side (Requirement 8) ----
  await invalidateSession(sessionData.session.id);

  return NextResponse.json({
    success: true,
    message: "Signed out successfully",
  });
}
