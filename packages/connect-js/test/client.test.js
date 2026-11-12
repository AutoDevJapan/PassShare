import assert from "node:assert/strict";
import test from "node:test";
import { ConnectClient } from "../dist/client.js";

test("ConnectClient trims only trailing slashes and preserves /v1 and content", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    const cases = [
      ["https://example.com///", "https://example.com/v1/vaults"],
      ["https://example.com/v1////", "https://example.com/v1/vaults"],
      ["https://example.com//nested/", "https://example.com//nested/v1/vaults"],
      ["https://example.com/v10/", "https://example.com/v10/v1/vaults"],
      ["https://example.com/ /", "https://example.com/ /v1/vaults"],
      ["////", "/v1/vaults"],
    ];
    for (const [host, expected] of cases) {
      await new ConnectClient({ host, token: "fixture-token" }).listVaults();
      assert.equal(urls.at(-1), expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConnectClient handles long malformed slash runs without backtracking", { timeout: 5000 }, async () => {
  const originalFetch = globalThis.fetch;
  const slashes = "/".repeat(1_000_000);
  let actual;
  globalThis.fetch = async (url) => {
    actual = String(url);
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    for (const [host, expected] of [
      [`https://example.com${slashes}!`, `https://example.com${slashes}!/v1/vaults`],
      [`https://example.com/v1${slashes}`, "https://example.com/v1/vaults"],
    ]) {
      await new ConnectClient({ host, token: "fixture-token" }).listVaults();
      assert.equal(actual, expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ConnectClient normalizes /v1 base URL", async () => {
  process.env.OP_CONNECT_HOST = "https://example.com";
  process.env.OP_CONNECT_TOKEN = "token";
  const { ConnectClient } = await import("../dist/client.js");
  const client = ConnectClient.fromEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/example\.com\/v1\//);
    return {
      ok: true,
      status: 200,
      json: async () => [],
    };
  };
  try {
    await client.listVaults();
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OP_CONNECT_HOST;
    delete process.env.OP_CONNECT_TOKEN;
  }
});
test('Connect errors preserve only an anchored public PS code', async () => {
  const original=globalThis.fetch;
  try {
    for(const [message,code] of [['PS015: Creation result changed','PS015'],['PS055: Ciphertext storage required','PS055'],['untrusted PS015: text',undefined]]){
      globalThis.fetch=async()=>new Response(JSON.stringify({message}),{status:409});
      const client=new ConnectClient({host:'https://example.test',token:'synthetic'});
      await assert.rejects(client.createItem('box',{},'operation'),error=>error.status===409&&error.code===code);
    }
  }finally{globalThis.fetch=original;}
});
