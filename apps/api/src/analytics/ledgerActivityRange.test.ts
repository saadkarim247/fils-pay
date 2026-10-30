/**
 * Bug 65: every analytics endpoint takes `to` as EXCLUSIVE (parseDateRange's
 * contract, and the dashboard's "To (exclusive)" field), but
 * /recent-ledger-activity used BETWEEN, so it also returned the whole `to`
 * day.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

test("recent-ledger-activity treats `to` as exclusive, in Bahrain days", async () => {
  const m = await h.merchant({ label: "ledger-range" });
  // Ledger groups must balance at commit, so each pair goes in one transaction.
  const client = await h.pool.connect();
  try {
    for (const [at, label] of [
      ["2026-07-01T12:00:00+03:00", "inside"],
      ["2026-07-02T00:30:00+03:00", "on-the-to-day"], // 21:30 UTC on 1 July
    ] as const) {
      await client.query("BEGIN");
      const g = (await client.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await client.query(
        `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES ($1, $2, 'merchant_payable', 'credit', 1000, $3, $4),
                ($1, $2, 'card_scheme_clearing', 'debit', 1000, $3, $4)`,
        [g, m.merchantId, at, label],
      );
      await client.query("COMMIT");
    }
  } finally {
    client.release();
  }

  const res = await h.app.inject({
    method: "GET",
    url: "/v1/analytics/recent-ledger-activity?from=2026-07-01&to=2026-07-02",
    headers: h.bearer(m),
  });
  assert.equal(res.statusCode, 200, res.body);
  const labels = (res.json() as { points: Array<{ description: string }> }).points.map((p) => p.description);
  assert.ok(labels.includes("inside"), res.body);
  assert.ok(!labels.includes("on-the-to-day"), `the exclusive 'to' day leaked in: ${res.body}`);
});

