/**
 * Capacity: past its limit the API must turn the excess away fast, not queue
 * it. The load test showed the limit is the database pool: with every
 * connection busy, new requests waited up to 5 s for one and then failed,
 * some part-way through a checkout (bug 73). Once requests are already
 * queued for a connection, a new one gets 503 + Retry-After at once.
 * Health checks are never shed.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("loadShedding.test.ts requires DATABASE_URL");

// A bounded wait like the real pool (pg defaults to waiting forever).
const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2_000 });
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  SHED_WHEN_POOL_WAITING: "1",
});
const app = buildApp(config, pool);

after(async () => {
  await app.close();
  await pool.end();
});

test("with requests already queued for a connection, new ones get 503 at once; health checks still answer", async () => {
  const held = await pool.connect(); // the pool's only connection
  let released = false;
  const release = () => { if (!released) { released = true; held.release(); } };
  const queued = app.inject({ method: "GET", url: "/v1/payment-links/plink_does_not_exist" });
  try {
    while (pool.waitingCount < 1) await new Promise((r) => setTimeout(r, 5));

    const started = Date.now();
    const shed = await app.inject({ method: "GET", url: "/v1/payment-links/plink_also_missing" });
    assert.equal(shed.statusCode, 503, shed.body);
    assert.equal(shed.json().error, "overloaded");
    assert.equal(shed.headers["retry-after"], "1");
    assert.ok(Date.now() - started < 500, "turned away immediately, not after waiting for a connection");

    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
  } finally {
    release(); // whatever happened, so the pool can drain and close
  }
  assert.equal((await queued).statusCode, 404, "the request already queued is still served");
  const after = await app.inject({ method: "GET", url: "/v1/payment-links/plink_missing_again" });
  assert.equal(after.statusCode, 404, "normal service resumes once the queue drains");
});
