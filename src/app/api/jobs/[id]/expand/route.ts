import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import { validateCsrfToken } from '@/lib/csrf';
import { checkSlidingRateLimit } from '@/lib/sliding-rate-limit';
import prisma from '@/lib/prisma';
import { expandListing } from '@/lib/ai/gemini';
import { extractionResultSchema } from '@/lib/ai/schemas';
import { ProviderTimeoutError } from '@/lib/ai/errors';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

declare global {
  var __inFlightExpands: Set<string> | undefined;
}

function getInFlightExpands(): Set<string> {
  if (!globalThis.__inFlightExpands) {
    globalThis.__inFlightExpands = new Set<string>();
  }
  return globalThis.__inFlightExpands;
}

export async function POST(
  request: Request,
  context: RouteContext
): Promise<NextResponse> {
  // 1. Session check
  const auth = await validateSession();
  if (!auth) {
    return NextResponse.json(
      { success: false, message: 'Authentication required' },
      { status: 401 }
    );
  }

  // 2. CSRF check
  const isCsrfValid = await validateCsrfToken(request);
  if (!isCsrfValid) {
    return NextResponse.json(
      { success: false, message: 'Invalid or missing CSRF token' },
      { status: 403 }
    );
  }

  const { id } = await context.params;

  // 3. Scoped query
  const job = await prisma.job.findFirst({
    where: {
      id,
      userId: auth.session.userId,
    },
  });

  if (!job) {
    return NextResponse.json(
      { success: false, message: 'Job not found' },
      { status: 404 }
    );
  }

  if (job.status !== 'done') {
    return NextResponse.json(
      { success: false, message: 'Expansion is only permitted on completed jobs' },
      { status: 400 }
    );
  }

  // Idempotency: If already expanded, return cached result immediately without consuming rate limit or calling Gemini
  if (job.expandedResult) {
    return NextResponse.json({
      success: true,
      expandedResult: job.expandedResult,
    });
  }

  // 4. Rate limit check (Sliding Window: 20 requests per 10 minutes)
  const rateLimit = await checkSlidingRateLimit(auth.session.userId, 'expand');
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        success: false,
        message: 'Too many expand requests. Please try again later.',
        retryAfter: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: rateLimit.headers,
      }
    );
  }

  // 5. In-flight concurrency gate per Job ID
  const inFlight = getInFlightExpands();
  if (inFlight.has(id)) {
    return NextResponse.json(
      { success: false, message: 'Expansion is already running for this job' },
      { status: 409, headers: rateLimit.headers }
    );
  }

  inFlight.add(id);

  try {
    const validatedData = extractionResultSchema.safeParse(job.result);
    if (!validatedData.success) {
      return NextResponse.json(
        { success: false, message: 'Job structured data is invalid for expansion' },
        { status: 400, headers: rateLimit.headers }
      );
    }

    const { expandedText } = await expandListing(validatedData.data);

    // Persist expanded result
    await prisma.job.update({
      where: { id },
      data: {
        expandedResult: expandedText,
      },
    });

    return NextResponse.json(
      {
        success: true,
        expandedResult: expandedText,
      },
      {
        headers: rateLimit.headers,
      }
    );
  } catch (error) {
    console.error(`[expand] Error expanding job ${id}:`, error);

    if (error instanceof ProviderTimeoutError) {
      return NextResponse.json(
        {
          success: false,
          message: 'The AI service timed out while generating the expanded listing.',
        },
        { status: 504, headers: rateLimit.headers }
      );
    }

    return NextResponse.json(
      {
        success: false,
        message: 'The AI service failed to generate the expanded listing.',
      },
      { status: 502, headers: rateLimit.headers }
    );
  } finally {
    inFlight.delete(id);
  }
}
