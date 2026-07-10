/**
 * Resolve the Express `trust proxy` setting used to derive `req.ip`.
 *
 * The per-IP login throttle relies on a trustworthy client IP. A raw
 * `X-Forwarded-For` value is attacker-controlled (the left-most entry is
 * spoofable), so we never trust it directly. Instead we configure Express with
 * a fixed number of trusted proxy hops and read `req.ip`, which walks the
 * forwarded chain from right to left, skipping exactly the trusted hops.
 *
 * Deployed environments sit behind a single Railway edge proxy, so the default
 * hop count there is 1. Local development has no proxy, so the default is 0
 * (use the socket address, ignore any forwarded header). Operators can override
 * the hop count with the `TRUST_PROXY_HOPS` environment variable if the number
 * of front-facing proxies changes.
 *
 * @param {string} [appEnv]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} Non-negative integer hop count for `app.set('trust proxy')`.
 */
export function resolveTrustProxyHops(appEnv = "local", env = process.env) {
  const override = env.TRUST_PROXY_HOPS?.trim();
  if (override) {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
    throw new Error(
      `Invalid TRUST_PROXY_HOPS: "${env.TRUST_PROXY_HOPS}" (expected a non-negative integer)`,
    );
  }

  // Local/test runs have no front-facing proxy; trust nothing so a spoofed
  // X-Forwarded-For can never override the real socket address.
  if (appEnv === "local") {
    return 0;
  }

  // prd / stg / preview / dev all run behind exactly one Railway edge proxy.
  return 1;
}
