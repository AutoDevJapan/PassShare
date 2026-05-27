/**
 * Connect API error helper.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} message
 */
export function sendConnectError(res, status, message) {
  res.status(status).json({ status, message });
}

/** @param {import('express').Request} req */
export function getBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim();
}

export function resolveConnectToken() {
  return process.env.OP_CONNECT_TOKEN ?? process.env.CONNECT_TOKEN ?? null;
}
