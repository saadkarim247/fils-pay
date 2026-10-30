import { randomInt, randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { createSeededRng } from "./rng.js";
import type {
  AcquirerAuthorizeRequest,
  AcquirerAuthorizeResult,
  AcquirerCaptureRequest,
  AcquirerCaptureResult,
  AcquirerOutcome,
  AcquirerRefundRequest,
  AcquirerRefundResult,
  AcquirerSimulator,
} from "./types.js";

const DECLINE_REASONS = ["do_not_honor", "insufficient_funds", "card_expired", "suspected_fraud"];

interface RandomSource {
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** Crypto-backed randomness, used when no deterministic seed is configured. */
function cryptoRandomSource(): RandomSource {
  return {
    int(min, max) {
      return randomInt(min, max + 1);
    },
    chance(probability) {
      const resolution = 1_000_000;
      const clamped = Math.max(0, Math.min(1, probability));
      return randomInt(0, resolution) < Math.round(clamped * resolution);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("cryptoRandomSource.pick: items must not be empty");
      }
      const idx = randomInt(0, items.length);
      return items[idx] as T;
    },
  };
}

/** Seeded, reproducible randomness — used when `config.acquirerRngSeed` is
 *  set, so a fixed seed plus a fixed sequence of calls reproduces
 *  byte-identical latency/outcome sequences. */
function seededRandomSource(seed: number): RandomSource {
  const rng = createSeededRng(seed);
  return {
    int(min, max) {
      return rng.int(min, max);
    },
    chance(probability) {
      return rng.next() < probability;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("seededRandomSource.pick: items must not be empty");
      }
      const idx = Math.floor(rng.next() * items.length);
      return items[Math.min(idx, items.length - 1)] as T;
    },
  };
}

/**
 * Only the simulator knobs from Config.
 * — MK
 */
type SimulatorConfig = Pick<
  Config,
  "acquirerLatencyMinMs" | "acquirerLatencyMaxMs" | "acquirerFailureRate" | "acquirerRngSeed"
>;

/**
 * In-process simulated acquirer. Lives in `apps/api` rather than a separate
 * service: the load test only needs observable HTTP-boundary latency, which
 * an in-process `await sleep(ms)` produces identically to an out-of-process
 * call, at zero extra RAM/CPU cost — a meaningful saving under the 0.5 vCPU
 * / 512 MB budget for the whole platform.
 */
/**
 * A Map that keeps only the most recent `max` entries (a Map iterates in
 * insertion order, so the first key is the oldest).
 */
function boundedCache<V>(max: number): { get(key: string): V | undefined; set(key: string, value: V): void } {
  const map = new Map<string, V>();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

export function createAcquirerSimulator(
  config: SimulatorConfig,
  opts: { idempotencyCacheMax?: number } = {},
): AcquirerSimulator {
  const random = config.acquirerRngSeed !== null ? seededRandomSource(config.acquirerRngSeed) : cryptoRandomSource();

  // In-process idempotency caches, one per operation. A retried call with
  // the same idempotency key returns the cached result unchanged rather
  // than re-rolling latency/outcome, so a client retry after a timeout
  // gets a consistent acquirer response. In-memory and process-local: a
  // deliberate fit for this platform's single small container target, not
  // durable across a process restart or multiple replicas. Bounded: they
  // grew with every checkout until a restart (bug 79). A retry comes seconds
  // later; 50,000 entries is ~45 minutes of checkouts at full load.
  const max = opts.idempotencyCacheMax ?? 50_000;
  const authorizeCache = boundedCache<AcquirerAuthorizeResult>(max);
  const captureCache = boundedCache<AcquirerCaptureResult>(max);
  const refundCache = boundedCache<AcquirerRefundResult>(max);

  async function applyLatency(): Promise<number> {
    const ms = random.int(config.acquirerLatencyMinMs, config.acquirerLatencyMaxMs);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return ms;
  }

  function rollOutcome(): { outcome: AcquirerOutcome; declineReason?: string } {
    if (!random.chance(config.acquirerFailureRate)) {
      return { outcome: "approved" };
    }
    if (random.chance(0.7)) {
      return { outcome: "declined", declineReason: random.pick(DECLINE_REASONS) };
    }
    return { outcome: "error" };
  }

  function magicOutcomeForPan(pan: string): { outcome: AcquirerOutcome; declineReason?: string } | null {
    if (pan.endsWith("0002")) return { outcome: "declined", declineReason: "do_not_honor" };
    if (pan.endsWith("0119")) return { outcome: "declined", declineReason: "insufficient_funds" };
    if (pan.endsWith("0069")) return { outcome: "error" };
    return null;
  }

  return {
    async authorize(req: AcquirerAuthorizeRequest): Promise<AcquirerAuthorizeResult> {
      const cached = authorizeCache.get(req.idempotencyKey);
      if (cached) return cached;

      // Deterministic magic test cards are checked first, independent of
      // the failure-rate roll.
      const rolled = magicOutcomeForPan(req.card.pan) ?? rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerAuthorizeResult = {
        outcome: rolled.outcome,
        acquirerReference: `acq_${randomUUID()}`,
        ...(rolled.declineReason !== undefined ? { declineReason: rolled.declineReason } : {}),
        latencyMs,
      };
      authorizeCache.set(req.idempotencyKey, result);
      return result;
    },

    async capture(req: AcquirerCaptureRequest): Promise<AcquirerCaptureResult> {
      const cached = captureCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerCaptureResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      captureCache.set(req.idempotencyKey, result);
      return result;
    },

    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      const cached = refundCache.get(req.idempotencyKey);
      if (cached) return cached;

      const rolled = rollOutcome();
      const latencyMs = await applyLatency();

      const result: AcquirerRefundResult = {
        outcome: rolled.outcome,
        acquirerReference: req.acquirerReference,
        latencyMs,
      };
      refundCache.set(req.idempotencyKey, result);
      return result;
    },
  };
}
