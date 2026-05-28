export const CLIENT_HEADER = "x-passshare-client";
/** @deprecated use CLIENT_HEADER */
export const MOBILE_CLIENT_HEADER = CLIENT_HEADER;
export const MOBILE_CLIENT_VALUE = "mobile";
export const EXTENSION_CLIENT_VALUE = "extension";

/** @param {import('express').Request} req */
function clientHeaderValue(req) {
  const value = req.headers[CLIENT_HEADER];
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** @param {import('express').Request} req */
export function isMobileClient(req) {
  return clientHeaderValue(req) === MOBILE_CLIENT_VALUE;
}

/** @param {import('express').Request} req */
export function isExtensionClient(req) {
  return clientHeaderValue(req) === EXTENSION_CLIENT_VALUE;
}

/** Mobile / Extension clients receive JSON refresh + Connect tokens instead of cookies. */
/** @param {import('express').Request} req */
export function isTokenAuthClient(req) {
  return isMobileClient(req) || isExtensionClient(req);
}
