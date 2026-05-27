import assert from "node:assert/strict";
import test from "node:test";

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
