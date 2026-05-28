import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { connectHttpError } from "../middleware/connect-errors.js";
import { normalizeItemBody } from "./categories.js";

/**
 * Parse 1Password 1PUX export (ZIP containing JSON items).
 * @param {Buffer} zipBuffer
 * @returns {Promise<object[]>}
 */
export async function parse1puxBuffer(zipBuffer) {
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

  const raw = await jsonEntry.buffer();
  return parseJsonExport(raw);
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

/**
 * @param {import('express').Request} req
 * @returns {Promise<Buffer>}
 */
export async function readRequestBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
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
