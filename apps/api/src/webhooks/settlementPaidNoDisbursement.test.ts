/**
 * Delivering a settlement.paid webhook must not create payout disbursement
 * records. A disbursement is the record of money sent on the payout rail
 * and is written once, by the settlement service, when the batch is paid
 * (ARCHITECTURE: "pay ... records disbursement"). The dispatcher used to
 * insert one per delivery row: once per merchant endpoint, again on every
 * replay, and never for a merchant with no endpoint.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import type { WebhookTransport } from "./transport.js";

const h = createTestHarness();
const ok: WebhookTransport = async () => ({ statusCode: 200, body: "" });

async function paidBatchWithEvent(merchantId: string, netPayoutFils: number): Promise<string> {
  const batch = await h.pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at)
     VALUES ($1, $2, 'paid', $3, 0, $3, now()) RETURNING id`,
    [merchantId, `2026-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`, netPayoutFils],
  );
  const batchId = batch.rows[0]!.id;
  await h.pool.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ('settlement.paid', 'settlement_batch', $1, $2)`,
    [batchId, JSON.stringify({ merchantId, batchId, batchDate: "2026-04-01", netPayoutFils })],
  );
  return batchId;
}

async function disbursementCount(batchId: string): Promise<number> {
  const r = await h.pool.query(`SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, [batchId]);
  return r.rowCount ?? 0;
}

test("delivering settlement.paid to a merchant with two endpoints writes no disbursement records", async () => {
  const m = await h.merchant({ label: "paid-webhook" });
  for (const url of ["http://127.0.0.1:9/a", "http://127.0.0.1:9/b"]) {
    await createWebhookEndpoint(h.pool, h.config, { merchantId: m.merchantId, url, createdByType: "merchant_session", createdById: randomUUID() });
  }
  const batchId = await paidBatchWithEvent(m.merchantId, 48_750);

  await runDispatchPass(h.pool, ok, h.config);

  const deliveries = await h.pool.query(
    `SELECT 1 FROM webhook_deliveries wd JOIN outbox_events oe ON oe.id = wd.outbox_event_id
      WHERE oe.aggregate_id = $1 AND wd.status = 'succeeded'`,
    [batchId],
  );
  assert.equal(deliveries.rowCount, 2, "both endpoints are still notified");
  assert.equal(await disbursementCount(batchId), 0, "notification must not create payout disbursement records");
});
