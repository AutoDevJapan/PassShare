/**
 * Security headers for API responses (HSTS, CSP, baseline hardening).
 * @param {string} appEnv
 */
export function createSecurityHeadersMiddleware(appEnv = "local") {
  const isProductionLike = appEnv === "prd" || appEnv === "stg";

  /** @type {import('express').RequestHandler} */
  return (_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );

    if (isProductionLike) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  };
}
