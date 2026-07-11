/**
 * Resolve the `pg` Pool `ssl` option for a given database connection string.
 *
 * All PassShare secrets are transported over this connection, so the server
 * certificate MUST be verified whenever the traffic leaves a trusted network.
 * The previous behaviour disabled verification unconditionally for any
 * `railway.app` host (`rejectUnauthorized: false`), which allowed a
 * man-in-the-middle to impersonate the database. This helper makes verification
 * the secure default and only relaxes it when an operator explicitly opts in.
 *
 * Resolution order:
 * 1. No URL → `undefined` (no pool, nothing to configure).
 * 2. Railway private network (`*.railway.internal`) → `undefined`. This traffic
 *    never leaves Railway's internal VPC, so TLS is neither required nor offered
 *    by the managed Postgres endpoint. This is the path the backend runtime uses.
 * 3. A pinned CA is provided via `DATABASE_CA_CERT` (PEM contents) → verify the
 *    server certificate against that CA (`rejectUnauthorized: true`).
 * 4. A public / proxied host (`railway.app`, `rlwy.net`) or an explicit
 *    `sslmode=require|verify-ca|verify-full` in the URL → require TLS with
 *    certificate verification. Verification is only disabled when
 *    `DATABASE_SSL_ALLOW_INSECURE === "true"` is set as a deliberate escape hatch.
 * 5. Anything else (e.g. a local Postgres) → `undefined` (no TLS).
 *
 * @param {string | null | undefined} databaseUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('pg').ConnectionOptions['ssl']}
 */
export function resolveDbSslConfig(databaseUrl, env = process.env) {
  if (!databaseUrl) {
    return undefined;
  }

  // Railway private networking terminates inside the VPC; no TLS is presented.
  if (databaseUrl.includes(".railway.internal")) {
    return undefined;
  }

  const ca = env.DATABASE_CA_CERT?.trim();
  if (ca) {
    return { ca, rejectUnauthorized: true };
  }

  const requiresTls =
    databaseUrl.includes("railway.app") ||
    databaseUrl.includes("rlwy.net") ||
    /[?&]sslmode=(require|verify-ca|verify-full)\b/.test(databaseUrl);

  if (!requiresTls) {
    return undefined;
  }

  // Secure by default: verify the server certificate. Skipping verification is a
  // MITM risk and must be an explicit, auditable operator decision.
  const allowInsecure = env.DATABASE_SSL_ALLOW_INSECURE === "true";
  return { rejectUnauthorized: !allowInsecure };
}
