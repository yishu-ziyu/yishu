/**
 * Bound a server-side auth request without cancelling the underlying Pi
 * operation.  Logout deliberately continues after the wire request times
 * out: AuthService keeps its provider transition active until the real
 * operation settles, so a late credential deletion cannot race a new login.
 */
export type AuthWatchdogResult<T> =
  | { timedOut: true }
  | { timedOut: false; value: T };

export function runAuthWatchdog<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  onTimeout: () => void,
): Promise<AuthWatchdogResult<T>> {
  const duration = Number.isFinite(timeoutMilliseconds)
    ? Math.max(1, Math.floor(timeoutMilliseconds))
    : 30_000;

  return new Promise<AuthWatchdogResult<T>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // A failed wire write must not turn the bounded request into an
        // unhandled rejection or release the underlying auth operation.
      }
      resolve({ timedOut: true });
    }, duration);

    // Attach both handlers immediately.  A late rejection after timeout is
    // intentionally consumed so a hung Pi operation cannot become an
    // unhandled process-level rejection.
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function resolveAuthWatchdogTimeoutMs(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const configured = Number(environment.YISHU_AUTH_WATCHDOG_MS);
  if (!Number.isFinite(configured) || configured < 1) return 30_000;
  return Math.min(Math.floor(configured), 300_000);
}
