/**
 * Bug 61: admin invite codes are bearer secrets (whoever holds one can
 * become an admin), so they must come from node:crypto. generateInviteCode
 * had its own Math.random() loop that bug 44's fix to lib/random.ts missed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateInviteCode } from "./inviteCode.js";

test("invite codes do not depend on Math.random", () => {
  const original = Math.random;
  Math.random = () => 0; // a predictable source would now give "AAAAAAAA" every time
  try {
    const codes = new Set(Array.from({ length: 20 }, () => generateInviteCode()));
    assert.ok(codes.size > 1, `20 codes collapsed to ${[...codes].join(", ")}`);
    for (const code of codes) assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  } finally {
    Math.random = original;
  }
});
