/** Offline files only; never executes SQL or auto-binds identities. */
import { readFile, writeFile } from "node:fs/promises";
import { classify, mappingSql } from "./mapping-risk.ts";
const [mode, input, output, backupPath] = process.argv.slice(2);
if (!["candidates", "sql"].includes(mode) || !input || !output) {
  throw Error(
    "Usage: candidates FCC.json plan.json BACKUP.json | sql reviewed-plan.json reviewed.sql",
  );
}
const records = JSON.parse(await readFile(input, "utf8"));
let result: string;
if (mode === "candidates") {
  if (!backupPath) throw Error("BACKUP_REQUIRED");
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  result = JSON.stringify(
    classify(records, backup.rows, backup.bindings ?? []),
    null,
    2,
  );
} else result = mappingSql(records);
await writeFile(output, result, { mode: 0o600, flag: "wx" });
