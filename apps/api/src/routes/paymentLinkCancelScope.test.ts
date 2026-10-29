/**
 * A merchant can only cancel its OWN payment links.
 *
 * The cancel route checks that the merchant in the URL is the caller, but
 * the cancel query matched the link by id alone. These tests use two real
 * merchants and real links created through the API, and check that a
 * foreign link can't be cancelled, isn't disclosed, and stays payable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness, type TestMerchant } from "../testSupport/fixtures.js";

const h = createTestHarness();

async function createLink(m: TestMerchant): Promise<{ id: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/payment-links`,
    headers: h.bearer(m),
    payload: { amountFils: 2500, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string };
}

function cancel(caller: TestMerchant, linkId: string) {
  return h.app.inject({
    method: "DELETE",
    url: `/v1/merchants/${caller.merchantId}/payment-links/${linkId}`,
    headers: h.bearer(caller),
  });
}

async function linkStatus(id: string): Promise<string> {
  const r = await h.pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [id]);
  return r.rows[0]!.status;
}

test("merchant B cannot cancel merchant A's active link; it stays active", async () => {
  const a = await h.merchant({ label: "link-owner" });
  const b = await h.merchant({ label: "link-attacker" });
  const link = await createLink(a);

  const res = await cancel(b, link.id);
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(await linkStatus(link.id), "active");
});

test("a foreign link's status is not disclosed (404, not 409 with its status)", async () => {
  const a = await h.merchant({ label: "link-owner" });
  const b = await h.merchant({ label: "link-prober" });
  const link = await createLink(a);
  assert.equal((await cancel(a, link.id)).statusCode, 204);

  const probe = await cancel(b, link.id);
  assert.equal(probe.statusCode, 404, probe.body);
  assert.ok(!probe.body.includes("canceled"), "must not reveal another merchant's link status");
});

test("the owner can still cancel its own link, and a second cancel is a 409", async () => {
  const a = await h.merchant({ label: "link-owner" });
  const link = await createLink(a);
  assert.equal((await cancel(a, link.id)).statusCode, 204);
  assert.equal(await linkStatus(link.id), "canceled");
  assert.equal((await cancel(a, link.id)).statusCode, 409);
});
