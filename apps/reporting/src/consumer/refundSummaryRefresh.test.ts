/**
 * The per-merchant daily refund summary (refund_merchant_summary, 0072) must
 * reflect real refunds, and the reporting worker refreshes it after each
 * settlement run (its own stated design). It was always empty: the view
 * joined transactions ON t.id = r.id (a refund id, never a transaction id),
 * and nothing ever refreshed it. It also summed the sale's captured amount
 * once per refund, double-counting a sale refunded in several parts.
 *
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refundSummaryRefresh.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

async function merchantWithRefundedSale(): Promise<{ merchantId: string; batchId: string }> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name) VALUES ($1) RETURNING id`, [`Refund summary ${randomUUID().slice(0, 8)}`]);
  const merchantId = m.rows[0]!.id;
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference)
     VALUES ($1, 'partially_refunded', 10000, 10000, 6000, $2) RETURNING id`,
    [merchantId, `acq-${randomUUID()}`],
  );
  for (const [amount, fee] of [[4_000, 100], [2_000, 50]] as const) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, reason,
                            created_by_type, created_by_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'succeeded', 'acq-r', 'test', 'merchant_api_key', gen_random_uuid(), '2026-07-01T09:00:00+03:00')`,
      [t.rows[0]!.id, merchantId, amount, fee],
    );
  }
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils)
     VALUES ($1, '2026-07-01', 'closed', 0, 0, 0) RETURNING id`,
    [merchantId],
  );
  return { merchantId, batchId: b.rows[0]!.id };
}

test("after a settlement batch closes, the refund summary shows the merchant's refunds, captured counted once", async () => {
  const { merchantId, batchId } = await merchantWithRefundedSale();

  await withTransaction(pool, (client) =>
    applyEvent(client, {
      id: "0",
      event_type: "settlement.batch_closed",
      aggregate_id: batchId,
      payload: { merchantId, batchId, batchDate: "2026-07-01", grossFils: 0, feeFils: 0, netPayoutFils: 0 },
      created_at: new Date(),
    } as never),
  );

  const r = await pool.query<{ refund_count: string; total_refunded_fils: string; total_fee_reversed_fils: string; original_captured_fils: string }>(
    `SELECT refund_count::text, total_refunded_fils::text, total_fee_reversed_fils::text, original_captured_fils::text
       FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(r.rowCount, 1, "one summary row for the merchant's refund day");
  assert.deepEqual(r.rows[0], {
    refund_count: "2",
    total_refunded_fils: "6000",
    total_fee_reversed_fils: "150",
    original_captured_fils: "10000",
  });
});
