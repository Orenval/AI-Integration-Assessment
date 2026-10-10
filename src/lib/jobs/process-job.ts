import prisma from '@/lib/prisma';
import { getObjectBytes } from '@/lib/storage/r2';
import { extractListing } from '@/lib/ai/gemini';
import { RETRY_CONFIG } from '@/lib/ai/config';
import {
  ProviderTimeoutError,
  ProviderTransientError,
  ProviderPermanentError,
  ValidationError,
} from '@/lib/ai/errors';
import { Prisma } from '@prisma/client';

// =============================================================================
// Background Job Worker
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processes a single extraction job asynchronously.
 * Guarantees that every execution path terminates in 'done' or 'failed'.
 */
export async function processJob(jobId: string): Promise<'done' | 'failed'> {
  // 1. Atomically claim the job to prevent duplicate execution across workers
  const claimResult = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: 'pending',
    },
    data: {
      status: 'processing',
      errorMessage: null,
    },
  });

  if (claimResult.count === 0) {
    console.log(`[worker] Job ${jobId} was already claimed or does not exist. Skipping.`);
    return 'failed';
  }

  let attempts = 0;
  let isValidationRetry = false;
  let userSafeErrorMessage = 'The AI processing failed.';

  try {
    // 2. Fetch the claimed job record
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      console.error(`[worker] Claimed job ${jobId} not found in database`);
      return 'failed';
    }

    // 3. Download the image bytes from Cloudflare R2
    let imageBytes: Buffer;
    try {
      imageBytes = await getObjectBytes(job.storageKey);
    } catch (storageErr) {
      console.error(`[worker] Failed to download image from R2 for job ${jobId}:`, storageErr);
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          errorMessage: 'Failed to retrieve uploaded image from storage.',
        },
      });
      return 'failed';
    }

    // 4. Execution & Retry Loop
    while (attempts < RETRY_CONFIG.maxAttempts) {
      attempts++;

      // Update attempt count in database
      await prisma.job.update({
        where: { id: jobId },
        data: { attempts },
      });

      try {
        const { result, rawModelOutput } = await extractListing(
          imageBytes,
          job.mimeType,
          isValidationRetry
        );

        // 5. On success: persist result, rawModelOutput, and mark done
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'done',
            result: result as unknown as Prisma.InputJsonValue,
            rawModelOutput: rawModelOutput as unknown as Prisma.InputJsonValue,
            errorMessage: null,
          },
        });

        return 'done';
      } catch (err) {
        console.error(`[worker] Attempt ${attempts} failed for job ${jobId}:`, err);

        if (err instanceof ProviderTimeoutError) {
          if (attempts < RETRY_CONFIG.maxAttempts) {
            const backoffMs = RETRY_CONFIG.backoffDelaysMs[attempts - 1] ?? 1000;
            await sleep(backoffMs);
            continue;
          }
          userSafeErrorMessage = 'The AI service took too long to respond.';
          break;
        }

        if (err instanceof ProviderTransientError) {
          if (attempts < RETRY_CONFIG.maxAttempts) {
            const backoffMs = RETRY_CONFIG.backoffDelaysMs[attempts - 1] ?? 1000;
            await sleep(backoffMs);
            continue;
          }
          userSafeErrorMessage = 'The AI service is temporarily unavailable. Please try again later.';
          break;
        }

        if (err instanceof ValidationError) {
          if (!isValidationRetry && attempts < RETRY_CONFIG.maxAttempts) {
            isValidationRetry = true;
            const backoffMs = RETRY_CONFIG.backoffDelaysMs[attempts - 1] ?? 1000;
            await sleep(backoffMs);
            continue;
          }
          userSafeErrorMessage = `The AI returned data in the wrong format after ${attempts} tries.`;
          break;
        }

        if (err instanceof ProviderPermanentError) {
          userSafeErrorMessage = 'The AI service could not process this image.';
          break;
        }

        // Uncategorized unexpected error
        userSafeErrorMessage = 'An unexpected error occurred during AI processing.';
        break;
      }
    }

    // 6. Fail job with user-safe message
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        errorMessage: userSafeErrorMessage,
      },
    });

    return 'failed';
  } catch (criticalError) {
    console.error(`[worker] Critical fatal error processing job ${jobId}:`, criticalError);

    // 7. Guaranteed recovery from thrown error: never leave in "processing"
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          errorMessage: 'The job could not be completed due to an internal error.',
        },
      });
    } catch (finalErr) {
      console.error(`[worker] Failed to set failure status for job ${jobId}:`, finalErr);
    }

    return 'failed';
  }
}
