import pkg from "fast-json-patch";

const { applyPatch } = pkg;

/**
 * @param {object} document
 * @param {import('fast-json-patch').Operation[]} patches
 */
export function patchDocument(document, patches) {
  return applyPatch(structuredClone(document), patches, true).newDocument;
}
