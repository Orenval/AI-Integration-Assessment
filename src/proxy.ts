// =============================================================================
// Next.js Proxy (formerly Middleware) — Route Protection & Redirects
// =============================================================================
// Requirement 10: Protected endpoints — /dashboard and /verify-email require a
// valid session cookie.
// Requirement 16: SPA-style navigation with addressable URLs.
//
// Proxy runs on the edge/Node runtime before routes are rendered. It performs
// a lightweight check (cookie existence) to redirect unauthenticated users.
// The full session validation (token hash lookup, timeout checks) happens in
// the API routes and the client-side AuthGuard — Proxy is the first line of
// defense, not the only one.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_ROUTES = ["/dashboard", "/verify-email"];

export function proxy(request: NextRequest): NextResponse {
    const { pathname } = request.nextUrl;
    const sessionToken = request.cookies.get("session_token")?.value;

    if (PROTECTED_ROUTES.some((route) => pathname.startsWith(route))) {
        if (!sessionToken) {
            return NextResponse.redirect(new URL("/signin", request.url));
        }
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};