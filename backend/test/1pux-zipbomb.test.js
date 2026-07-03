import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";

import {
  parse1puxBuffer,
  guardDecompressedTotal,
  MAX_DECOMPRESSED_BYTES,
} from "../src/lib/1pux-import.js";

/**
 * Build a minimal single-entry ZIP by hand (Node has no zip writer).
 * @param {string} name
 * @param {Buffer} data
 * @param {{ method?: 0 | 8, declaredUncompressedSize?: number }} [opts]
 */
function makeZip(name, data, opts = {}) {
  const method = opts.method ?? 0; // 0 = STORED, 8 = DEFLATE
  const nameBuf = Buffer.from(name, "utf8");
  const stored = method === 8 ? deflateRawSync(data) : data;
  const crc = crc32(data) >>> 0;
  const compSize = stored.length;
  const uncompSize = opts.declaredUncompressedSize ?? data.length;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // modtime
  local.writeUInt16LE(0, 12); // moddate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compSize, 18);
  local.writeUInt32LE(uncompSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12); // modtime
  central.writeUInt16LE(0, 14); // moddate
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compSize, 20);
  central.writeUInt32LE(uncompSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra len
  central.writeUInt16LE(0, 32); // comment len
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset
  nameBuf.copy(central, 46);

  const localBlock = Buffer.concat([local, stored]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(1, 8); // entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12); // cd size
  eocd.writeUInt32LE(localBlock.length, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([localBlock, central, eocd]);
}

const PAYLOAD = Buffer.from(
  JSON.stringify({
    items: [{ title: "Imported Login", category: "LOGIN", fields: [] }],
  }),
);

test("guardDecompressedTotal throws 413/PS018 over the cap", () => {
  assert.throws(
    () => guardDecompressedTotal(101, 100),
    (err) => err.status === 413 && /PS018/.test(err.message),
  );
});

test("guardDecompressedTotal is a no-op at or under the cap", () => {
  assert.doesNotThrow(() => guardDecompressedTotal(100, 100));
  assert.doesNotThrow(() => guardDecompressedTotal(0, 100));
});

test("MAX_DECOMPRESSED_BYTES is a sane, bounded ceiling", () => {
  assert.ok(MAX_DECOMPRESSED_BYTES >= 1024 * 1024);
  assert.ok(MAX_DECOMPRESSED_BYTES <= 512 * 1024 * 1024);
});

test("parses a valid ZIP 1PUX export", async () => {
  const zip = makeZip("export.json", PAYLOAD);
  const items = await parse1puxBuffer(zip);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Imported Login");
});

test("rejects a ZIP whose entry declares a size beyond the cap", async () => {
  const zip = makeZip("export.json", PAYLOAD);
  await assert.rejects(
    () => parse1puxBuffer(zip, { maxDecompressedBytes: 10 }),
    (err) => err.status === 413 && /PS018/.test(err.message),
  );
});

test("rejects a ZIP that decompresses past the cap despite spoofed small metadata", async () => {
  // DEFLATE entry lying about its uncompressed size: the cheap metadata check
  // passes but the metered stream must still trip the guard (#323).
  const big = Buffer.from(JSON.stringify({ items: [{ title: "x".repeat(5000) }] }));
  const zip = makeZip("export.json", big, {
    method: 8,
    declaredUncompressedSize: 8,
  });
  await assert.rejects(
    () => parse1puxBuffer(zip, { maxDecompressedBytes: 100 }),
    (err) => err.status === 413 && /PS018/.test(err.message),
  );
});
