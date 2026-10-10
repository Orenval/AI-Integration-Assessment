// =============================================================================
// GET /api/auth/csrf — CSRF Token Endpoint
// =============================================================================
// Generates a new CSRF token and sets it as a non-HttpOnly cookie.
// Called by the client on page load to obtain a valid CSRF token for
// subsequent state-changing requests.

import { NextResponse } from "next/server";
import { generateCsrfToken } from "@/lib/csrf";

export async function GET(): Promise<NextResponse> {
  const token = await generateCsrfToken();

  return NextResponse.json({
    success: true,
    message: "CSRF token generated",
    data: { csrfToken: token },
  });
}
