/**
 * Bug 68: the API server treated a missing (or misspelled) NODE_ENV as
 * "development": it returned the OTP code in the login response, logged it
 * in plaintext, accepted the built-in dev encryption key and dropped the
 * Secure cookie flag. The compose file never loads ops/.env.docker (where
 * NODE_ENV=production lives), and am notes "our staging has NODE_ENV unset".
 * The server must refuse to start unless NODE_ENV is explicit.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Starts src/index.ts and reports whether it began listening or exited. */
function boot(nodeEnv: string | undefined): Promise<{ outcome: "listening" | "exited"; code: number | null; output: string }> {
  // A valid 32-byte key: the built-in dev fallback decodes to 34 bytes and
  // is rejected in every mode, which would stop the server for another reason.
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
  delete env.NODE_ENV;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "index.ts")], { env });
  let output = "";
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ outcome: "exited", code: null, output: `${output}\n(timed out)` });
    }, 20_000);
    const onData = (d: Buffer) => {
      output += d.toString();
      if (/listening/i.test(output)) {
        clearTimeout(timer);
        child.kill();
        resolve({ outcome: "listening", code: null, output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ outcome: /listening/i.test(output) ? "listening" : "exited", code, output });
    });
  });
}

test("the server refuses to start without NODE_ENV", async () => {
  const r = await boot(undefined);
  assert.equal(r.outcome, "exited", `it started listening in an unknown mode:\n${r.output}`);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /NODE_ENV/);
});

test("the server refuses a misspelled NODE_ENV", async () => {
  const r = await boot("prod");
  assert.equal(r.outcome, "exited", r.output);
  assert.match(r.output, /NODE_ENV/);
});

test("an explicit NODE_ENV still starts the server", async () => {
  const r = await boot("test");
  assert.equal(r.outcome, "listening", r.output);
});
