import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { connectHttpError } from "../middleware/connect-errors.js";
import { normalizeItemBody } from "./categories.js";

// A 20 MiB upload can hold a ZIP that decompresses to gigabytes (a "zip bomb"),
// which would OOM the process during extraction. Cap the decompressed size of
// the JSON entry we actually read. 100 MiB is far larger than any real 1Password
// export JSON yet bounds the blast radius. See #323.
export const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

/**
 * Parse 1Password 1PUX export (ZIP containing JSON items).
 * @param {Buffer} zipBuffer
 * @param {{ maxDecompressedBytes?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function parse1puxBuffer(zipBuffer, options = {}) {
  const maxDecompressedBytes = options.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  if (!zipBuffer || zipBuffer.length === 0) {
    throw connectHttpError(400, "PS017: Invalid 1PUX — empty payload");
  }

  const firstByte = zipBuffer[0];
  if (firstByte === 0x7b || firstByte === 0x5b) {
    return parseJsonExport(zipBuffer);
  }

  const { default: unzipper } = await import("unzipper");
  let directory;
  try {
    directory = await unzipper.Open.buffer(zipBuffer);
  } catch {
    throw connectHttpError(400, "PS017: Invalid 1PUX — archive is not a valid ZIP export");
  }
  const jsonEntry = directory.files.find((file) =>
    file.path.toLowerCase().endsWith(".json"),
  );

  if (!jsonEntry) {
    throw connectHttpError(400, "PS017: Invalid 1PUX — no JSON export found in archive");
  }

  const raw = await readEntryCapped(jsonEntry, maxDecompressedBytes);
  return parseJsonExport(raw);
}

/**
 * Throw a 413 when a running/declared decompressed byte count exceeds the cap.
 * @param {number} total
 * @param {number} maxBytes
 */
export function guardDecompressedTotal(total, maxBytes) {
  if (total > maxBytes) {
    throw connectHttpError(
      413,
      "PS018: 1PUX archive decompresses beyond the maximum allowed size",
    );
  }
}

/**
 * Read a ZIP entry's decompressed bytes with a hard size cap. The central
 * directory's declared size is checked first (cheap rejection), then the actual
 * stream is metered in case the declared size was spoofed.
 * @param {{ uncompressedSize?: number, stream: () => Readable, buffer: () => Promise<Buffer> }} entry
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readEntryCapped(entry, maxBytes) {
  const declared = Number(entry.uncompressedSize);
  if (Number.isFinite(declared)) {
    guardDecompressedTotal(declared, maxBytes);
  }

  const stream = entry.stream();
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      guardDecompressedTotal(total, maxBytes);
      chunks.push(chunk);
    }
  } catch (err) {
    stream.destroy();
    if (err && err.status === 413) {
      throw err;
    }
    throw connectHttpError(400, "PS017: Invalid 1PUX — archive is not a valid ZIP export");
  }
  return Buffer.concat(chunks);
}

/**
 * @param {Buffer} raw
 * @returns {Promise<object[]>}
 */
async function parseJsonExport(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw connectHttpError(400, "PS017: Invalid 1PUX — malformed JSON export");
  }

  const items = extractItemsFromExport(parsed);
  if (items.length === 0) {
    throw connectHttpError(400, "PS017: Invalid 1PUX — no importable items found");
  }
  return items;
}

/**
 * @param {unknown} parsed
 * @returns {object[]}
 */
function extractItemsFromExport(parsed) {
  if (Array.isArray(parsed)) {
    return parsed.filter(isImportableItem);
  }
  if (parsed && typeof parsed === "object") {
    const record = /** @type {Record<string, unknown>} */ (parsed);
    for (const key of ["items", "exportedItems", "accounts"]) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(isImportableItem);
      }
    }
    if (isImportableItem(record)) {
      return [record];
    }
  }
  return [];
}

/**
 * @param {unknown} value
 */
function isImportableItem(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof /** @type {Record<string, unknown>} */ (value).title === "string"
  );
}

/**
 * Map 1Password export item to Connect item create body.
 * @param {object} source
 */
export function map1puxItemToConnectBody(source) {
  const record = /** @type {Record<string, unknown>} */ (source);
  const category =
    typeof record.category === "string"
      ? record.category.toUpperCase().replace(/\s+/g, "_")
      : "LOGIN";

  const body = {
    title: String(record.title),
    category,
    fields: Array.isArray(record.fields)
      ? record.fields.map(mapField)
      : [],
    tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
  };

  return normalizeItemBody(body);
}

/**
 * @param {unknown} field
 */
function mapField(field) {
  const record = /** @type {Record<string, unknown>} */ (field ?? {});
  return {
    label: String(record.label ?? record.id ?? "field"),
    type: String(record.type ?? "STRING").toUpperCase(),
    purpose: record.purpose ? String(record.purpose).toUpperCase() : undefined,
    value: String(record.value ?? ""),
  };
}

// Upload cap for raw 1PUX/zip bodies (not covered by express.json's limit).
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MiB

/**
 * @param {import('express').Request} req
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
export async function readRequestBodyBuffer(req, maxBytes = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      throw connectHttpError(413, "PS016: Upload exceeds the maximum allowed size");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {Readable} stream
 * @returns {Promise<string>}
 */
export async function saveUploadToTemp(stream) {
  const tempPath = join(tmpdir(), `passshare-1pux-${randomBytes(8).toString("hex")}.zip`);
  await pipeline(stream, createWriteStream(tempPath));
  return tempPath;
}

/**
 * @param {string} tempPath
 * @returns {Promise<Buffer>}
 */
export async function readTempFile(tempPath) {
  try {
    return await fs.readFile(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}
