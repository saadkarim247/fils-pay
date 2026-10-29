/**
 * The capture-side tier check must read the platform volume counter
 * correctly once it is past 2^31 fils (~2,147,483 BD): the tier (2,000,000
 * BD) is earned well before that, and must stay earned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestHarness } from "../testSupport/fixtures.js";
import { getVolumeTierBonusBps } from "./platformVolumeTier.js";

const h = createTestHarness();

test("a platform past 2,147,483 BD of volume still gets the 15 bps tier bonus", async () => {
  const original = await h.pool.query<{ v: string }>(`SELECT total_processed_fils::text AS v FROM platform_stats WHERE id = 1`);
  try {
    await h.pool.query(`UPDATE platform_stats SET total_processed_fils = 2500000000 WHERE id = 1`);
    const client = await h.pool.connect();
    try {
      assert.equal(await getVolumeTierBonusBps(client), 15);
    } finally {
      client.release();
    }
  } finally {
    await h.pool.query(`UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, [original.rows[0]!.v]);
  }
});
