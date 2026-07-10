import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportOnepasswordCsv } from "../lib/csv-export.ts";

describe("exportOnepasswordCsv", () => {
  it("exports login rows with headers", () => {
    const csv = exportOnepasswordCsv([
      {
        id: "abcdefghijklmnopqrstuvwxyz",
        title: "Site",
        category: "LOGIN",
        tags: ["work"],
        favorite: false,
        username: "user",
        password: "pass",
        url: "https://example.com",
        notes: "note",
      },
    ]);

    assert.match(csv, /Title,Username,Password,URL,Notes,Tags/);
    assert.match(csv, /Site/);
    assert.match(csv, /user/);
    assert.match(csv, /pass/);
  });

  it("neutralizes spreadsheet formula injection in fields", () => {
    const csv = exportOnepasswordCsv([
      {
        id: "abcdefghijklmnopqrstuvwxyz",
        title: "=HYPERLINK(\"http://evil\")",
        category: "LOGIN",
        tags: [],
        favorite: false,
        username: "+cmd",
        password: "pass",
        url: "",
        notes: "@formula",
      },
    ]);

    // Dangerous leading chars are prefixed with an apostrophe (quoted because the
    // title also contains a comma/quote).
    assert.match(csv, /"'=HYPERLINK/);
    assert.match(csv, /'\+cmd/);
    assert.match(csv, /'@formula/);
    // A benign value is untouched.
    assert.match(csv, /,pass,/);
  });

  it("keeps password-less items such as secure notes", () => {
    const csv = exportOnepasswordCsv([
      {
        id: "abcdefghijklmnopqrstuvwxyz",
        title: "Recovery codes",
        category: "SECURE_NOTE",
        tags: [],
        favorite: false,
        username: null,
        password: null,
        url: null,
        notes: "one two three",
      },
    ]);

    const rows = csv.trimEnd().split("\n");
    // Header + one data row: the note is not dropped.
    assert.equal(rows.length, 2);
    assert.match(csv, /Recovery codes/);
    assert.match(csv, /one two three/);
    // The Password column is empty for a note (Title,Username,Password,...).
    assert.match(csv, /Recovery codes,,,/);
  });
});
