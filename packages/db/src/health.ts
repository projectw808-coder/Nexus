export type DatabaseHealth = { ok: true; latencyMs: number } | { ok: false; error: string };

const HEALTH_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`database health check timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Runs `SELECT 1` against the database with a 2s timeout. Never throws.
 *
 * The client module is imported lazily so that importing `@nexus/db` for its
 * enums and types does not require DATABASE_URL to be set.
 */
export async function checkDatabase(): Promise<DatabaseHealth> {
  const startedAt = performance.now();
  try {
    const { basePrisma } = await import('./client.ts');
    await withTimeout(basePrisma.$queryRaw`SELECT 1`, HEALTH_TIMEOUT_MS);
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
