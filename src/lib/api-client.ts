// =============================================================================
// API Client — Fetch Wrapper with CSRF Token
// =============================================================================
// Used by client-side components to make API requests with automatic CSRF
// token inclusion. Reads the csrf_token cookie and sends it as an
// X-CSRF-Token header on every request.
//
// Requirement 15: CSRF double-submit cookie pattern — the client reads the
// non-HttpOnly CSRF cookie and includes it as a header that a cross-origin
// attacker cannot forge.

/**
 * Read a cookie value by name from document.cookie.
 */
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";");
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split("=");
    if (key.trim() === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }
  return null;
}

/**
 * Standard API response shape for all auth endpoints.
 */
export interface ApiResponse<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Record<string, string[]>;
  retryAfter?: number;
  // HTTP status of the response — lets callers distinguish an expired session
  // (401) from other failures so they can trigger re-authentication.
  status?: number;
  // "Resend cooldown, enforced server-side": exact ISO timestamp of the
  // server-imposed resendCooldownUntil, returned by /api/auth/resend-code
  // (both the 429 cooldown rejection and the GET status check) so the client
  // countdown can sync to the DB truth instead of a client-only timer.
  resendCooldownUntil?: string;
}

/**
 * Ensures a CSRF token cookie is present in the browser.
 */
export async function ensureCsrfToken(): Promise<string | null> {
  let token = getCookie("csrf_token");
  if (!token) {
    try {
      const res = await fetch("/api/auth/csrf", { method: "GET" });
      const data = await res.json();
      token = data?.data?.csrfToken || getCookie("csrf_token");
    } catch {
      // ignore network errors on CSRF prefetch
    }
  }
  return token;
}

/**
 * Make an API request with automatic CSRF token inclusion.
 *
 * @param url - The API endpoint URL (e.g. "/api/auth/signup").
 * @param options - Standard fetch options. Method defaults to "POST".
 * @returns The parsed JSON response.
 */
export async function apiFetch<T = undefined>(
  url: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  let csrfToken = getCookie("csrf_token");
  if (!csrfToken && (options.method === "POST" || !options.method)) {
    csrfToken = await ensureCsrfToken();
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (csrfToken) {
    headers["x-csrf-token"] = csrfToken;
  }

  const response = await fetch(url, {
    method: "POST",
    ...options,
    headers,
    credentials: "same-origin",
  });

  const data: ApiResponse<T> = await response.json();
  return { ...data, status: response.status };
}
