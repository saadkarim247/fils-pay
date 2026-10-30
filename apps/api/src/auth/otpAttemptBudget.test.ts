/**
 * The OTP guess budget (max 5 attempts per login) must hold.
 *   - Parallel guesses: verify read attempt_count, compared, and only then
 *     incremented, so a burst of simultaneous guesses all passed the check.
 *   - Resend: its contract says the new challenge "inherits the previous
 *     challenge's attempt_count", but it started from 0 again.
 * Both turned 5 guesses into an unlimited number against a 6-digit code.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cookieNamed, createTestHarness } from "../testSupport/fixtures.js";
import { sha256Hex } from "../lib/crypto.js";

const h = createTestHarness();

async function passwordStep(): Promise<{ cookie: string; otp: string }> {
  const email = `budget-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signup = await h.app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: { legalName: "Budget Co", registrationNumber: `RC-${randomUUID().slice(0, 8)}`, businessType: "llc",
        contactEmail: `c-${randomUUID()}@example.test`, contactPhone: "+97300000000", addressLine1: "1 St", city: "Manama" },
      owner: { email, password },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const login = await h.app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId: (signup.json() as { merchantId: string }).merchantId, email, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  return { cookie: cookieNamed(login.headers["set-cookie"], h.config.cookieName), otp: (login.json() as { devOtpCode: string }).devOtpCode };
}

const verify = (cookie: string, code: string) =>
  h.app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });

const wrong = (otp: string) => (otp === "000000" ? "111111" : "000000");

test("20 simultaneous wrong guesses are held to the 5-attempt budget", async () => {
  const { cookie, otp } = await passwordStep();
  const results = await Promise.all(Array.from({ length: 20 }, () => verify(cookie, wrong(otp))));
  const judged = results.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(judged <= 5, `only 5 guesses may be checked against the code, ${judged} were`);
  assert.equal((await verify(cookie, otp)).statusCode === 200, false, "the budget is spent, even the right code is refused");
});

test("a resend keeps the attempts already used", async () => {
  const { cookie, otp } = await passwordStep();
  for (let i = 0; i < 4; i++) assert.equal((await verify(cookie, wrong(otp))).statusCode, 401);

  // Let the 30-second resend throttle pass, then resend.
  const token = decodeURIComponent(cookie.split("=")[1]!);
  await h.pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = $1)`,
    [sha256Hex(token)],
  );
  const resend = await h.app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const newOtp = (resend.json() as { devOtpCode: string }).devOtpCode;

  assert.equal((await verify(cookie, wrong(newOtp))).statusCode, 401, "the 5th attempt");
  const sixth = await verify(cookie, newOtp);
  assert.equal(sixth.statusCode, 429, `a 6th attempt must be refused: ${sixth.body}`);
});

test("the right code within budget still logs in", async () => {
  const { cookie, otp } = await passwordStep();
  assert.equal((await verify(cookie, wrong(otp))).statusCode, 401);
  assert.equal((await verify(cookie, otp)).statusCode, 200);
});
