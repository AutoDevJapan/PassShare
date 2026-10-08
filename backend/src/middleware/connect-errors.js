import { sendConnectError } from "./connect-auth.js";

/** @type {import('express').RequestHandler} */
export function connectNotFound(_req, res) {
  sendConnectError(res, 404, "PS012: Resource not found");
}

/** @param {unknown} err @param {import('express').Request} _req @param {import('express').Response} res @param {import('express').NextFunction} next */
export function connectErrorHandler(err, _req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err && typeof err === "object" && err.code === "P0055") {
    sendConnectError(res,409,"PS055: Ciphertext storage required");
    return;
  }
  if (err && typeof err === "object" && "status" in err && "message" in err) {
    sendConnectError(res, /** @type {number} */ (err.status), /** @type {string} */ (err.message));
    return;
  }
  sendConnectError(res, 500, "PS008: Internal server error");
}

/** @param {number} status @param {string} message */
export function connectHttpError(status, message) {
  const error = new Error(message);
  // @ts-expect-error attach status
  error.status = status;
  // @ts-expect-error attach message
  error.message = message;
  error.code = /^PS\d{3}/.exec(message)?.[0] ?? "PS000";
  return error;
}
