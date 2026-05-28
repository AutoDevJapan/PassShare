import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostnameMatchesItem } from "../src/lib/connect-items.ts";
import { generatePassword } from "../src/lib/password-generator.ts";

describe("hostnameMatchesItem", () => {
  it("matches exact hostname", () => {
    assert.equal(
      hostnameMatchesItem("login.example.com", "https://login.example.com/path"),
      true,
    );
  });

  it("matches subdomain against registered host", () => {
    assert.equal(hostnameMatchesItem("app.example.com", "https://example.com"), true);
  });

  it("ignores invalid URLs", () => {
    assert.equal(hostnameMatchesItem("example.com", "not-a-url"), false);
  });
});

describe("generatePassword", () => {
  it("returns password with requested minimum length", () => {
    const password = generatePassword(16);
    assert.equal(password.length, 16);
  });

  it("includes character classes", () => {
    const password = generatePassword(20);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[!@#$%^&*()\-_=+[\]{}]/);
  });
});
