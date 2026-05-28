import type { ConnectItem } from "@shared/types/item.js";

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Export Connect items to 1Password-compatible CSV. */
export function exportOnepasswordCsv(items: ConnectItem[]): string {
  const lines = ["Title,Username,Password,URL,Notes,Tags"];
  for (const item of items) {
    if (!item.password) {
      continue;
    }
    const row = [
      item.title,
      item.username ?? "",
      item.password,
      item.url ?? "",
      item.notes ?? item.body ?? "",
      item.tags.join(", "),
    ];
    lines.push(row.map(escapeCsv).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function downloadCsvFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
