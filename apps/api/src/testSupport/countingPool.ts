import type { Pool, PoolClient } from "pg";

/** Wraps a pool so every query sent through it, or through a client it hands
 *  out, is counted. Used by the N+1 tests to pin round trips. */
export function countingPool(pool: Pool): { pool: Pool; count: () => number; reset: () => void } {
  let n = 0;
  const countQueries = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        const value = (t as Record<PropertyKey, unknown>)[prop];
        if (prop === "query") {
          return (...args: unknown[]) => {
            n += 1;
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        if (prop === "connect") {
          return async () => countQueries((await (value as () => Promise<PoolClient>).apply(t)) as PoolClient);
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });
  return { pool: countQueries(pool), count: () => n, reset: () => { n = 0; } };
}
