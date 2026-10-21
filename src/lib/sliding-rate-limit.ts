// =============================================================================
// PostgreSQL Sliding Window Rate Limiter
// =============================================================================
// Enforces request throughput caps on AI endpoints (Upload & Expand) using a
// rolling time window recorded in PostgreSQL via Prisma.
//
// Unlike brute-force auth lockouts, this tracks actual request volume over time
// windows defined in `ROUTE_RATE_LIMITS` (e.g. 10 requests / 10 min for upload,
// 20 requests / 10 min for expand) and emits standard RFC 6585 headers.

import prisma from './prisma';
import { ROUTE_RATE_LIMITS } from './ai/config';

export type RateLimitedRoute = keyof typeof ROUTE_RATE_LIMITS;

export interface SlidingRateLimitResult {
  /** Whether the request is permitted to proceed. */
  allowed: boolean;
  /** Maximum allowed requests within the rolling window. */
  limit: number;
  /** Number of remaining allowed requests within the current window. */
  remaining: number;
  /** Date/time when the current rate limit window resets or oldest request expires. */
  resetAt: Date;
  /** Seconds until the client may retry (only present when blocked). */
  retryAfterSeconds?: number;
  /** RFC 6585 compliant HTTP response headers. */
  headers: Record<string, string>;
}

/**
 * Checks and records a request under the sliding window rate limit for a user.
 *
 * @param userId - ID of the authenticated user.
 * @param route - Route key ("upload" | "expand") matching ROUTE_RATE_LIMITS.
 * @returns Rate limit status, remaining quota, and RFC headers.
 */
export async function checkSlidingRateLimit(
  userId: string,
  route: RateLimitedRoute
): Promise<SlidingRateLimitResult> {
  const config = ROUTE_RATE_LIMITS[route];
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);

  // 1. Count active requests within the current rolling window
  const activeCount = await prisma.apiRequestLog.count({
    where: {
      userId,
      route,
      createdAt: { gte: windowStart },
    },
  });

  // 2. Enforce quota ceiling
  if (activeCount >= config.maxRequests) {
    // Determine when the oldest request in the window expires to free up a slot
    const oldestInWindow = await prisma.apiRequestLog.findFirst({
      where: {
        userId,
        route,
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    const resetAt = oldestInWindow
      ? new Date(oldestInWindow.createdAt.getTime() + config.windowMs)
      : new Date(now.getTime() + config.windowMs);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((resetAt.getTime() - now.getTime()) / 1000)
    );

    return {
      allowed: false,
      limit: config.maxRequests,
      remaining: 0,
      resetAt,
      retryAfterSeconds,
      headers: {
        'Retry-After': String(retryAfterSeconds),
        'X-RateLimit-Limit': String(config.maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(resetAt.getTime() / 1000)),
      },
    };
  }

  // 3. Quota available: Record request timestamp atomically
  await prisma.apiRequestLog.create({
    data: {
      userId,
      route,
      createdAt: now,
    },
  });

  const remaining = Math.max(0, config.maxRequests - (activeCount + 1));
  const resetAt = new Date(now.getTime() + config.windowMs);

  return {
    allowed: true,
    limit: config.maxRequests,
    remaining,
    resetAt,
    headers: {
      'X-RateLimit-Limit': String(config.maxRequests),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(Math.ceil(resetAt.getTime() / 1000)),
    },
  };
}

/**
 * Sweeps expired ApiRequestLog entries older than the retention threshold.
 * Called periodically by the server maintenance background timer.
 *
 * @param maxRetentionMs - Retention duration in ms (defaults to 1 hour).
 * @returns Number of cleaned-up records.
 */
export async function cleanupExpiredApiRequestLogs(
  maxRetentionMs: number = 60 * 60 * 1000 // 1 hour
): Promise<number> {
  const cutoff = new Date(Date.now() - maxRetentionMs);
  const result = await prisma.apiRequestLog.deleteMany({
    where: {
      createdAt: { lt: cutoff },
    },
  });
  return result.count;
}
