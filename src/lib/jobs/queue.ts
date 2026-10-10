import pLimit, { LimitFunction } from 'p-limit';
import { MAX_CONCURRENT_JOBS } from '../ai/config';
import { processJob } from './process-job';

// =============================================================================
// Asynchronous Job Queue (In-Memory Singleton with Concurrency Cap)
// =============================================================================

interface GlobalQueueState {
  limiter: LimitFunction;
  inFlight: number;
}

declare global {
  var __jobQueueState: GlobalQueueState | undefined;
}

function getQueueState(): GlobalQueueState {
  if (!globalThis.__jobQueueState) {
    globalThis.__jobQueueState = {
      limiter: pLimit(MAX_CONCURRENT_JOBS),
      inFlight: 0,
    };
  }
  return globalThis.__jobQueueState;
}

/**
 * Enqueues a job ID for background processing.
 * Concurrency is capped at MAX_CONCURRENT_JOBS across the application.
 */
export function enqueueJob(jobId: string): void {
  const queue = getQueueState();

  void queue.limiter(async () => {
    queue.inFlight++;
    console.log(`[queue] start job=${jobId} inFlight=${queue.inFlight}/${MAX_CONCURRENT_JOBS}`);

    let status: 'done' | 'failed' = 'failed';
    try {
      status = await processJob(jobId);
    } catch (err) {
      console.error(`[worker] Unhandled error in worker for job ${jobId}:`, err);
      status = 'failed';
    } finally {
      console.log(`[queue] end   job=${jobId} inFlight=${queue.inFlight}/${MAX_CONCURRENT_JOBS} status=${status}`);
      queue.inFlight--;
    }
  });
}
