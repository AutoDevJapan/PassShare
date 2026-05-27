import { MIN_PASSWORD_LENGTH } from "./constants.js";
import { authHttpError } from "./errors.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** @param {unknown} email */
export function parseEmail(email) {
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    throw authHttpError(400, "PS020", "Invalid email address");
  }
  return email.trim().toLowerCase();
}

/** @param {unknown} password */
export function parsePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw authHttpError(
      400,
      "PS021",
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  return password;
}
