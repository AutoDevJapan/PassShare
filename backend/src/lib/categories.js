import { connectHttpError } from "../middleware/connect-errors.js";
import { generateConnectId, isValidConnectId } from "./connect.js";

/** Connect Item categories aligned with passshare-core ItemCategory. */
export const CONNECT_ITEM_CATEGORIES = Object.freeze([
  "LOGIN",
  "PASSWORD",
  "SECURE_NOTE",
  "CREDIT_CARD",
  "IDENTITY",
  "SSH_KEY",
  "CUSTOM",
]);

/**
 * @param {unknown} category
 * @returns {category is string}
 */
export function isValidConnectCategory(category) {
  return (
    typeof category === "string" &&
    CONNECT_ITEM_CATEGORIES.includes(category.toUpperCase())
  );
}

/**
 * @param {unknown} category
 * @returns {string}
 */
export function normalizeConnectCategory(category) {
  if (typeof category !== "string" || category.trim() === "") {
    return "LOGIN";
  }
  return category.toUpperCase();
}

/**
 * @param {object} body
 */
export function assertValidItemCategory(body) {
  if (body.category === undefined || body.category === null) {
    return;
  }
  if (!isValidConnectCategory(body.category)) {
    throw connectHttpError(
      400,
      `PS018: Invalid item category — allowed: ${CONNECT_ITEM_CATEGORIES.join(", ")}`,
    );
  }
}

/**
 * @param {unknown} fields
 */
export function normalizeItemFields(fields) {
  if (!Array.isArray(fields)) {
    return fields;
  }
  return fields.map((field) => {
    if (!field || typeof field !== "object") {
      return field;
    }
    const id =
      typeof field.id === "string" && isValidConnectId(field.id)
        ? field.id
        : generateConnectId();
    return { ...field, id };
  });
}

/**
 * @param {object} body
 * @returns {object}
 */
export function normalizeItemBody(body) {
  const normalized = { ...body };
  if (normalized.version !== undefined && (!Number.isSafeInteger(normalized.version) || normalized.version < 1)) {
    throw connectHttpError(400, "PS015: Item version must be a positive safe integer");
  }
  if (normalized.category !== undefined) {
    assertValidItemCategory(normalized);
    normalized.category = normalizeConnectCategory(normalized.category);
  }
  if (normalized.fields !== undefined) {
    normalized.fields = normalizeItemFields(normalized.fields);
  }
  return normalized;
}
