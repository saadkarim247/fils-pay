/**
 * Bug 73: a payment-link checkout that THROWS part-way (e.g. the database
 * pool is exhausted under load: "timeout exceeded when trying to connect")
 * skipped the undo steps that only ran for returned failures. The load test
 * left links paid with no captured money, open authorizations holding the
 * buyer's card, and links stuck reserved. Each stage must undo what came
 * before it when it throws, then let the error through.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createTestHarness, VALID_CARD, type TestMerchant } from "../testSupport/fixtures.js";
import { payPaymentLink } from "./pay.js";

const h = createTestHarness();
const POOL_TIMEOUT = "timeout exceeded when trying to connect";

/** The pool, except that the n-th connect() fails like an exhausted pool,
 *  or any query matching `failQuery` throws. */
function faultyPool(opts: { failConnectNumber?: number; failQuery?: RegExp }): Pool {
  let connects = 0;
  return new Proxy(h.pool, {
    get(target, prop) {
      if (prop === "connect") {
        return async () => {
          connects += 1;
          if (connects === opts.failConnectNumber) throw new Error(POOL_TIMEOUT);
          return target.connect();
        };
      }
      if (prop === "query") {
        return (text: unknown, ...rest: unknown[]) => {
          if (opts.failQuery && typeof text === "string" && opts.failQuery.test(text)) {
            return Promise.reject(new Error(POOL_TIMEOUT));
          }
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Pool;
}

async function link(m: TestMerchant): Promise<{ id: string; token: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: { ...h.bearer(m), "idempotency-key": randomUUID() },
    payload: { amountFils: 4_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

async function stateOf(linkId: string, merchantId: string) {
  const l = await h.pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
  const t = await h.pool.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM transactions WHERE merchant_id = $1 GROUP BY status ORDER BY status`,
    [merchantId],
  );
  return { link: l.rows[0]!.status, transactions: t.rows };
}

const pay = (pool: Pool, token: string) =>
  payPaymentLink(pool, h.app.acquirer, { paymentLinkReservationTimeoutSeconds: 60 }, {
    token,
    card: VALID_CARD,
    idempotencyKey: randomUUID(),
  });

test("a throw during authorize releases the link", async () => {
  const m = await h.merchant({ label: "pay-throw-authorize" });
  const l = await link(m);
  await assert.rejects(pay(faultyPool({ failConnectNumber: 1 }), l.token), new RegExp(POOL_TIMEOUT));
  assert.deepEqual(await stateOf(l.id, m.merchantId), { link: "active", transactions: [] });
});

test("a throw while committing the link voids the authorization and releases the link", async () => {
  const m = await h.merchant({ label: "pay-throw-commit" });
  const l = await link(m);
  await assert.rejects(pay(faultyPool({ failQuery: /SET status = 'paid'/ }), l.token), new RegExp(POOL_TIMEOUT));
  assert.deepEqual(await stateOf(l.id, m.merchantId), { link: "active", transactions: [{ status: "voided", n: 1 }] });
});

test("a throw during capture un-commits the link and voids the authorization", async () => {
  const m = await h.merchant({ label: "pay-throw-capture" });
  const l = await link(m);
  // connect #1 is authorize's transaction, #2 is capture's.
  await assert.rejects(pay(faultyPool({ failConnectNumber: 2 }), l.token), new RegExp(POOL_TIMEOUT));
  assert.deepEqual(await stateOf(l.id, m.merchantId), { link: "active", transactions: [{ status: "voided", n: 1 }] });
});

test("after a compensated failure the buyer can pay the link normally", async () => {
  const m = await h.merchant({ label: "pay-throw-retry" });
  const l = await link(m);
  await assert.rejects(pay(faultyPool({ failConnectNumber: 2 }), l.token));
  const ok = await pay(h.pool, l.token);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal((await stateOf(l.id, m.merchantId)).link, "paid");
});
