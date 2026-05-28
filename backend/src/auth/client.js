export const MOBILE_CLIENT_HEADER = "x-passshare-client";
export const MOBILE_CLIENT_VALUE = "mobile";

/** @param {import('express').Request} req */
export function isMobileClient(req) {
  const value = req.headers[MOBILE_CLIENT_HEADER];
  return typeof value === "string" && value.toLowerCase() === MOBILE_CLIENT_VALUE;
}
