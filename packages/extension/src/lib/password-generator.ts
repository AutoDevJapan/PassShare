// The extension now uses the single shared password generator (CSPRNG +
// rejection sampling, guaranteed character classes, no modulo bias). Kept as a
// thin re-export so the existing relative importers and the tsx test runner
// resolve it without needing the @shared alias. See #324.
export {
  generatePassword,
  DEFAULT_LENGTH,
  MIN_LENGTH,
  MAX_LENGTH,
} from "../../../../shared/lib/password-generator.ts";
