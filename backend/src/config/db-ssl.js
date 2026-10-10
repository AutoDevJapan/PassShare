/** Parse once at the configuration boundary; never include the URL in errors. */
function parseDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        url.searchParams.has("host")) {
      throw new Error("Invalid database URL");
    }
    // pg decodes the hostname and accepts a query host override. Reject that
    // override so the authority validated here is also the host pg consumes.
    const hostname = decodeURIComponent(url.hostname).toLowerCase();
    url.hostname = hostname;
    const modes = url.searchParams.getAll("sslmode");
    if (modes.some((mode) => !["disable", "allow", "prefer", "require", "verify-ca",
      "verify-full", "no-verify"].includes(mode))) {
      throw new Error("Invalid database URL");
    }
    // pg consumes the last value when a query key is repeated.
    const sslmode = modes.at(-1) ?? null;
    return { url, hostname, sslmode };
  } catch {
    throw new Error("Invalid database URL configuration");
  }
}

function resolveParsedSsl({ hostname, sslmode, url }, env) {
  // A terminal DNS dot denotes the same host; pg still consumes the original
  // hostname for connection and certificate identity checking.
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (host.endsWith(".railway.internal")) return undefined;

  const ca = env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  const requestsTls = (sslmode !== null && sslmode !== "disable" && sslmode !== "allow") ||
    ["true", "1", "no-verify"].includes(url.searchParams.get("ssl")) ||
    ["sslcert", "sslkey", "sslrootcert"].some((key) => Boolean(url.searchParams.get(key))) ||
    url.searchParams.get("sslnegotiation") === "direct";
  if (local && !requestsTls) return undefined;

  // Every host outside the trusted VPC/loopback boundary uses verified TLS,
  // including hosts unrelated to Railway and URLs requesting sslmode=disable.
  return { rejectUnauthorized: env.DATABASE_SSL_ALLOW_INSECURE !== "true" };
}

/**
 * Resolve TLS policy: Railway VPC -> no TLS; pinned CA -> verified TLS;
 * loopback without a TLS request -> no TLS; all other hosts -> verified TLS.
 * Only the exact DATABASE_SSL_ALLOW_INSECURE=true opt-out disables verification,
 * and it never overrides a pinned CA. URL TLS settings cannot weaken the policy.
 * @param {string | null | undefined} databaseUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('pg').ConnectionOptions['ssl']}
 */
export function resolveDbSslConfig(databaseUrl, env = process.env) {
  if (!databaseUrl) return undefined;
  return resolveParsedSsl(parseDatabaseUrl(databaseUrl), env);
}

/**
 * Build the actual Pool configuration. pg parses connectionString after the
 * explicit options and can replace ssl (including a pinned CA), or read files
 * named by sslcert/sslkey/sslrootcert. Remove these query options before pg sees
 * them; DATABASE_CA_CERT is the supported CA source for this application.
 * @param {string} databaseUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('pg').PoolConfig}
 */
export function resolveDbPoolConfig(databaseUrl, env = process.env) {
  const parsed = parseDatabaseUrl(databaseUrl);
  const ssl = resolveParsedSsl(parsed, env);
  const negotiation = parsed.url.searchParams.getAll("sslnegotiation").at(-1) ?? env.PGSSLNEGOTIATION ?? "postgres";
  if (!["postgres", "direct"].includes(negotiation)) throw new Error("Invalid database URL configuration");
  for (const key of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat", "sslnegotiation"]) {
    parsed.url.searchParams.delete(key);
  }
  // Keep direct TLS negotiation outside connectionString: pg otherwise creates
  // ssl=true while parsing it, replacing the pinned CA / verification policy.
  // Explicit values also keep PGSSLMODE/PGSSLNEGOTIATION off the no-TLS paths.
  return { connectionString: parsed.url.toString(), ssl: ssl ?? false,
    sslnegotiation: ssl ? negotiation : "postgres" };
}
