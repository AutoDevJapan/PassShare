const ERROR_PATTERN = /^(PS\d{3}):\s*(.+)$/;

export function formatTauriError(error: unknown): string {
  const raw = String(error).trim();
  const match = ERROR_PATTERN.exec(raw);
  if (match) {
    return match[2];
  }
  return raw;
}

export function isKnownErrorCode(error: unknown, code: string): boolean {
  return String(error).trim().startsWith(`${code}:`);
}
