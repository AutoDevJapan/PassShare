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
});
