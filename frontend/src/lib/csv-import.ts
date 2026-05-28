import type { ItemFormValues } from "@shared/types/item.js";
import { emptyFormValues } from "@shared/types/item.js";

type CsvRow = Record<string, string>;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines[0]).map(normalizeHeader);
  const rows: CsvRow[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? "").trim();
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.replace(/^"|"$/g, "").replace(/""/g, '"'));
}

export function parseOnepasswordCsv(csvData: string): ItemFormValues[] {
  const rows = parseCsv(csvData);
  if (rows.length === 0) {
    throw new Error("CSV is empty");
  }

  const firstRow = rows[0];
  if (!("title" in firstRow)) {
    throw new Error("Missing Title column");
  }

  const items: ItemFormValues[] = [];
  for (const row of rows) {
    const title = row.title ?? "";
    const password = row.password ?? "";
    if (!title || !password) {
      continue;
    }

    const values = emptyFormValues("LOGIN");
    values.title = title;
    values.password = password;
    values.username = row.username ?? "";
    values.url = row.url ?? row.website ?? "";
    values.notes = row.notes ?? "";
    values.tags = row.tags ?? "";
    items.push(values);
  }

  if (items.length === 0) {
    throw new Error("No importable rows found (Title and Password required)");
  }

  return items;
}
