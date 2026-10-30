/**
 * TS scenarios for the batch N+1 profile, run inside the migrate image:
 *   tsx perf/batch-n-plus-1/scenarios.ts <replay|recompute> <id...>
 * Times only the operation itself, inside one transaction exactly as the
 * admin routes run it. Prints {"ms": n, "result": ...}.
 */
import { Pool } from "pg";
import { replayWebhookDeliveriesBatch } from "../../apps/api/src/webhooks/replayBatch.js";
import { recomputeTransactionStatusesForMerchant } from "../../apps/api/src/admin/transactionStatusRecompute.js";
import { withTransaction } from "../../apps/api/src/db/withTransaction.js";

const [scenario, ...ids] = process.argv.slice(2);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function main(): Promise<void> {
  const started = performance.now();
  let result: unknown;
  if (scenario === "replay") {
    const [merchantId, endpointId, adminUserId] = ids as [string, string, string];
    const r = await replayWebhookDeliveriesBatch(pool, {
      merchantId, endpointId, adminUserId,
      from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-02T00:00:00Z"), statuses: ["exhausted"],
    });
    result = { matched: r.matchedCount, replayed: r.replayedDeliveryIds.length };
  } else if (scenario === "recompute") {
    result = await withTransaction(pool, (client) => recomputeTransactionStatusesForMerchant(client, ids[0]!));
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
  console.log(JSON.stringify({ ms: Math.round(performance.now() - started), result }));
}

main().finally(() => pool.end());
