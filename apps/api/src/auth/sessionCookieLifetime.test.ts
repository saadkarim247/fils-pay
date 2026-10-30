/**
 * Bug 59: merchants were logged out about 10 minutes after signing in. The
 * login step sets the cookie with the short pending lifetime (10 min);
 * merchant /otp/verify promoted the session server-side to 12 h but never
 * re-issued the cookie, so the browser dropped it when the pending lifetime
 * ran out. Admin verify already re-issues it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { cookieNamed, createTestHarness } from "../testSupport/fixtures.js";

const h = createTestHarness();

function setCookieLine(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  return lines.find((l: string) => l.startsWith(`${name}=`));
}

test("merchant OTP verify re-issues the session cookie for the full session lifetime", async () => {
  const email = `cookie-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signup = await h.app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: { legalName: "Cookie Co", registrationNumber: `RC-${randomUUID().slice(0, 8)}`, businessType: "llc",
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
  const pendingCookie = cookieNamed(login.headers["set-cookie"], h.config.cookieName);
  assert.match(setCookieLine(login.headers, h.config.cookieName)!, new RegExp(`Max-Age=${h.config.pendingSessionTtlMinutes * 60}`));

  const verify = await h.app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: pendingCookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);

  const line = setCookieLine(verify.headers, h.config.cookieName);
  assert.ok(line, "verify must re-issue the cookie, or the browser keeps the 10-minute one");
  assert.equal(line!.split(";")[0], pendingCookie, "same session token, only the lifetime changes");
  assert.match(line!, new RegExp(`Max-Age=${h.config.sessionTtlHours * 3_600}(;|$)`));
  assert.match(line!, /HttpOnly/);

  // The re-issued cookie is a working session.
  const me = await h.app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: pendingCookie } });
  assert.equal(me.statusCode, 200, me.body);
});
