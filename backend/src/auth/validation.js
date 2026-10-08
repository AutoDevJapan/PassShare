import { MIN_PASSWORD_LENGTH } from "./constants.js";
import { authHttpError } from "./errors.js";

// Each segment is separated by a character it cannot consume. Checking the
// final domain dot separately avoids quadratic backtracking on dotted input.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/** @param {unknown} email */
export function parseEmail(email) {
  const value = typeof email === "string" ? email.trim() : "";
  const dot = value.lastIndexOf(".");
  if (!EMAIL_PATTERN.test(value) || dot <= value.indexOf("@") + 1 || dot === value.length - 1) {
    throw authHttpError(400, "PS020", "Invalid email address");
  }
  return value.toLowerCase();
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
