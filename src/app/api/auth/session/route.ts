// =============================================================================
// GET /api/auth/session — Session Check
// =============================================================================
// Returns the current user's information if they have a valid session.
// Used by client-side components to check authentication state.
// Requirement 10: Protected endpoint — validates session server-side.

import { NextResponse } from "next/server";
import { validateSession } from "@/lib/session";

export async function GET(): Promise<NextResponse> {
  const sessionData = await validateSession();

  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    message: "Authenticated",
    data: {
      user: {
        id: sessionData.user.id,
        fullName: sessionData.user.fullName,
        email: sessionData.user.email,
        emailVerified: sessionData.user.emailVerified,
      },
    },
  });
}
