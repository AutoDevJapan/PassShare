/**
 * Allowed browser origins for Web session cookies (CORS credentials).
 */

const DEFAULT_LOCAL_ORIGIN = "http://localhost:5173";
/**
 * Fallback production web origin used only when `WEB_ORIGIN` is unset.
 *
 * The canonical Vercel alias `pass-share-frontend.vercel.app` currently returns
 * 404 (`DEPLOYMENT_NOT_FOUND`): it is not aliased to any deployment, since prod
 * is served through the custom domain below (see issue #374). The bare alias is
 * still a trusted CORS pattern via {@link VERCEL_HOSTNAME_PATTERN} in case Vercel
 * re-attaches it, but it must NOT be the default origin — a live host is required.
 */
const DEFAULT_PROD_WEB_ORIGIN = "https://pass-share.bm1314.net";

/**
 * Strictly bind trusted Vercel hostnames to this project's prefix.
 * Matches only the production host `pass-share-frontend.vercel.app` and
 * git-branch preview hosts like `pass-share-frontend-git-<branch>-<scope>.vercel.app`.
 * A bare `.vercel.app` suffix is NOT trusted, so an attacker-controlled
 * `evil.vercel.app` cannot become a credentialed CORS origin.
 */
const VERCEL_HOSTNAME_PATTERN = /^pass-share-frontend(-git-[a-z0-9-]+)?\.vercel\.app$/;

/**
 * A Vercel scope (team/user) slug carries a globally-unique random suffix that
 * only Vercel can mint for that scope, e.g. `masashi-matsumotos-projects-c5830f3d`.
 * We accept `[a-z0-9-]` (lowercase alnum + hyphen) — the character set Vercel uses.
 */
const VERCEL_TEAM_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Escape RegExp metacharacters in a literal string.
 * @param {string} value
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * When a git-branch preview label exceeds Vercel's 63-char limit, Vercel truncates
 * the project-name prefix and injects a short hash, producing hosts like
 * `pass-share-fron-git-ac642b-<team-slug>.vercel.app` (note: `-tend` dropped).
 * Such hosts do NOT match {@link VERCEL_HOSTNAME_PATTERN}, so credentialed CORS
 * would be denied for our own preview deployments.
 *
 * Binding to the deploying team's scope slug re-admits these truncated previews
 * WITHOUT weakening the #315 boundary: an attacker cannot mint a `*.vercel.app`
 * host ending in `-<our-team-slug>` because that suffix belongs to our Vercel scope.
 * @param {string} teamSlug
 * @returns {RegExp | null}
 */
function buildVercelTeamHostnamePattern(teamSlug) {
  if (!VERCEL_TEAM_SLUG_PATTERN.test(teamSlug)) {
    return null;
  }
  // Retain a project-name prefix (defense-in-depth against sibling projects in the
  // same team) while tolerating any truncation of `pass-share-frontend`.
  return new RegExp(`^pass-share-fro[a-z0-9-]*-${escapeRegExp(teamSlug)}\\.vercel\\.app$`);
}

/**
 * @param {string} hostname
 * @param {string} [teamSlug] optional Vercel scope slug (`VERCEL_TEAM_SLUG`)
 */
function isVercelHostname(hostname, teamSlug) {
  if (VERCEL_HOSTNAME_PATTERN.test(hostname)) {
    return true;
  }
  const trimmedSlug = teamSlug?.trim();
  if (trimmedSlug) {
    const teamPattern = buildVercelTeamHostnamePattern(trimmedSlug);
    if (teamPattern && teamPattern.test(hostname)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string | undefined | null} origin
 * @param {string} appEnv
 * @param {string | undefined} configuredOrigin
 * @param {string | undefined} [vercelTeamSlug] scope slug that re-admits truncated previews
 */
export function isAllowedWebOrigin(origin, appEnv = "local", configuredOrigin, vercelTeamSlug) {
  if (!origin || typeof origin !== "string") {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (appEnv === "local") {
    const allowed = configuredOrigin?.trim() || DEFAULT_LOCAL_ORIGIN;
    return origin === allowed;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  if (configuredOrigin && origin === configuredOrigin.trim()) {
    return true;
  }

  if (appEnv === "prd" || appEnv === "stg" || appEnv === "preview" || appEnv === "dev") {
    return isVercelHostname(parsed.hostname, vercelTeamSlug);
  }

  return origin === (configuredOrigin?.trim() || DEFAULT_PROD_WEB_ORIGIN);
}

/**
 * @param {string} appEnv
 */
export function defaultWebOrigin(appEnv = "local") {
  if (appEnv === "local") {
    return process.env.WEB_ORIGIN?.trim() || DEFAULT_LOCAL_ORIGIN;
  }
  return process.env.WEB_ORIGIN?.trim() || DEFAULT_PROD_WEB_ORIGIN;
}
