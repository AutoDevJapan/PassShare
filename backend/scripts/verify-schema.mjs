import { SCHEMA_SQL } from "../src/db/schema.js";

if (!SCHEMA_SQL.includes("connect_vaults")) {
  throw new Error("SCHEMA_SQL missing connect_vaults table");
}

if (!SCHEMA_SQL.includes("connect_item_files")) {
  throw new Error("SCHEMA_SQL missing connect_item_files table");
}

console.log("DB schema migration script verified (CREATE IF NOT EXISTS)");
