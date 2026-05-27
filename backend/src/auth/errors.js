/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
export function authHttpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** @param {import('express').Response} res @param {unknown} error */
export function sendAuthError(res, error) {
  if (error && typeof error === "object" && "status" in error && "code" in error) {
    const authError = /** @type {{ status: number, code: string, message: string }} */ (error);
    res.status(authError.status).json({
      error: authError.code,
      message: authError.message,
    });
    return;
  }
  res.status(500).json({ error: "PS000", message: "Internal server error" });
}
