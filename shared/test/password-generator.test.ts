import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generatePassword,
  MIN_LENGTH,
  MAX_LENGTH,
  DEFAULT_LENGTH,
} from "../lib/password-generator.ts";

const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const DIGIT = /[0-9]/;
const SYMBOL = /[!@#$%^&*]/;

test("defaults to DEFAULT_LENGTH", () => {
  assert.equal(generatePassword().length, DEFAULT_LENGTH);
});

test("honors a requested length", () => {
  assert.equal(generatePassword(32).length, 32);
});

test("clamps below the minimum", () => {
  assert.equal(generatePassword(4).length, MIN_LENGTH);
});

test("clamps above the maximum", () => {
  assert.equal(generatePassword(999).length, MAX_LENGTH);
});

test("falls back to the default for non-finite length", () => {
  assert.equal(generatePassword(NaN).length, DEFAULT_LENGTH);
});

test("guarantees every character class over many draws", () => {
  for (let i = 0; i < 500; i += 1) {
    const pw = generatePassword(MIN_LENGTH);
    assert.match(pw, LOWER, `missing lower: ${pw}`);
    assert.match(pw, UPPER, `missing upper: ${pw}`);
    assert.match(pw, DIGIT, `missing digit: ${pw}`);
    assert.match(pw, SYMBOL, `missing symbol: ${pw}`);
  }
});

test("uses only characters from the allowed alphabet", () => {
  const allowed = /^[a-zA-Z0-9!@#$%^&*]+$/;
  for (let i = 0; i < 100; i += 1) {
    assert.match(generatePassword(24), allowed);
  }
});

test("does not include visually ambiguous characters", () => {
  const ambiguous = /[lIO01]/;
  for (let i = 0; i < 200; i += 1) {
    assert.doesNotMatch(generatePassword(MAX_LENGTH), ambiguous);
  }
});

test("produces distinct passwords", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    seen.add(generatePassword());
  }
  assert.ok(seen.size > 95, `expected near-unique passwords, got ${seen.size}/100`);
});
