import type { ItemFormValues } from "@shared/types/item.js";
import { emptyFormValues } from "@shared/types/item.js";

type CsvRow = Record<string, string>;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function parseCsv(text: string): CsvRow[] {
  const records = splitCsvRecords(text);
  if (records.length === 0) {
    return [];
  }

  const headers = records[0].map(normalizeHeader);
  const rows: CsvRow[] = [];

  for (const cells of records.slice(1)) {
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

function splitCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let current = "";
  let inQuotes = false;
  let closed = false;
  const endCell = () => { cells.push(current); current = ""; closed = false; };
  const endRecord = () => {
    endCell();
    if (cells.some(cell => cell.trim().length > 0)) records.push(cells);
    cells = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { current += '"'; index++; }
        else { inQuotes = false; closed = true; }
      } else current += char;
      continue;
    }
    if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      endRecord();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (char === '"') {
      if (current.length > 0 || closed) throw new Error("Invalid CSV quoting");
      inQuotes = true;
    } else {
      if (closed) throw new Error("Invalid CSV text after closing quote");
      current += char;
    }
  }
  if (inQuotes) throw new Error("Unterminated CSV quoted field");
  if (current.length > 0 || closed || cells.length > 0) endRecord();
  return records;
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
