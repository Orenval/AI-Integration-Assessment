// =============================================================================
// Next.js Instrumentation — Process-Lifetime Maintenance
// =============================================================================
// `register()` runs once when the server process starts (Node.js runtime). It is
// the only place in the app that outlives a single request, so it hosts the
// periodic cleanup that has no natural request to attach to.
//
// Password reset tokens follow the VerificationCode lifecycle: deleted on use
// (reset-password) and deleted when superseded (forgot-password). The sweeper
// below closes the remaining gap — rows from abandoned attempts that expire and
// are never touched again. deleteMany is idempotent, so multiple server
// instances each running a sweep is safe (duplicate deletions are no-ops).
//
// Caveat: on serverless runtimes this timer never fires, so the per-request
// delete-on-use / delete-on-issue paths remain the authoritative cleanup.

/** How often to sweep expired, never-used reset tokens. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const globalForSweeper = globalThis as unknown as {
    resetTokenSweeperStarted?: boolean;
};

export async function register(): Promise<void> {
    // Edge runtime instances have no long-lived process for a timer. Load the
    // reset-code module lazily so the edge bundle never pulls in its crypto
    // dependency (Node-only) — the sweeper only exists on the Node runtime.
    if (process.env.NEXT_RUNTIME === "edge") return;

    const { cleanupExpiredResetTokens } = await import("@/lib/reset-code");

    // Guard against re-registration (e.g. dev-mode restarts of instrumentation).
    if (globalForSweeper.resetTokenSweeperStarted) return;
    globalForSweeper.resetTokenSweeperStarted = true;

    const timer = setInterval(async () => {
        try {
            const deleted = await cleanupExpiredResetTokens();
            if (deleted > 0) {
                console.log(
                    `[auth-maintenance] deleted ${deleted} expired reset token(s)`
                );
            }
        } catch (error) {
            console.error("[auth-maintenance] reset token sweep failed:", error);
        }
    }, SWEEP_INTERVAL_MS);

    // Don't keep the process alive just for the timer.
    timer.unref?.();
}