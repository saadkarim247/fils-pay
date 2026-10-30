/**
 * OTP codes and payment-link tokens must come from a cryptographic random
 * source (ARCHITECTURE: "Tokens are 128-bit, from crypto.randomBytes").
 * They came from Math.random, whose V8 state can be recovered from a few
 * observed outputs; a merchant sees many link tokens, which would let them
 * predict OTP codes. These tests make Math.random constant: if the output
 * still varies, the generator is not using it.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { displayReference, randomDigits, randomFromAlphabet } from "./random.js";

const realRandom = Math.random;
afterEach(() => {
  Math.random = realRandom;
});

test("OTP digits do not come from Math.random", () => {
  Math.random = () => 0;
  const codes = new Set(Array.from({ length: 50 }, () => randomDigits(6)));
  assert.ok(codes.size > 40, `50 codes, only ${codes.size} distinct: generator follows Math.random`);
});

test("link-token characters do not come from Math.random", () => {
  Math.random = () => 0.5;
  const tokens = new Set(Array.from({ length: 50 }, () => randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 22)));
  assert.equal(tokens.size, 50);
});

test("outputs keep their shape: n digits, alphabet-only, display reference format", () => {
  for (let i = 0; i < 200; i++) {
    assert.match(randomDigits(6), /^\d{6}$/);
    assert.match(randomFromAlphabet("AB", 10), /^[AB]{10}$/);
  }
  assert.match(displayReference(), /^FP-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
});

test("every digit and every alphabet letter can appear (no truncation bias)", () => {
  const digits = new Set(Array.from({ length: 2000 }, () => randomDigits(1)));
  assert.equal(digits.size, 10);
  const letters = new Set(Array.from({ length: 2000 }, () => randomFromAlphabet("ABCDEFG", 1)));
  assert.equal(letters.size, 7);
});
