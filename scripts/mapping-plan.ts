/** Offline only. Reads local normalized FCC inventory + private legacy backup.
 * Generates candidates, never automatically links or mutates a database. */
import { readFile, writeFile } from "node:fs/promises";
import {
  isObject,
  UUID,
} from "../supabase/functions/_shared/furry_event_contract.ts";
const [mode, input, output, legacyPath] = process.argv.slice(2);
if (!["candidates", "sql"].includes(mode) || !input || !output) {
  throw Error(
    "Usage: tsx scripts/mapping-plan.ts candidates FCC.json plan.json BACKUP.json | sql approved-plan.json reviewed.sql",
  );
}
const records: unknown = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(records)) throw Error("Input must be an array");
if (mode === "candidates") {
  if (!legacyPath) throw Error("Backup required");
  const legacy = JSON.parse(await readFile(legacyPath, "utf8")).rows;
  const plans = records.map((r) => {
    if (!isObject(r) || typeof r.fcc_id !== "string" || !UUID.test(r.fcc_id)) {
      throw Error("Invalid UUID");
    }
    return {
      fcc_id: r.fcc_id,
      name: r.name,
      start_at: r.start_at,
      decision: null,
      event_id: null,
      reason: null,
      candidates: legacy.filter((old: Record<string, unknown>) =>
        old.name === r.name ||
        String(old.start_at ?? "").slice(0, 10) ===
          String(r.start_at ?? "").slice(0, 10) ||
        old.organization && old.organization === r.organization
      ).map((old: Record<string, unknown>) => ({
        id: old.id,
        name: old.name,
        start_at: old.start_at,
        city: old.city,
        organization: old.organization,
        is_active: old.is_active,
      })),
    };
  });
  await writeFile(output, JSON.stringify(plans, null, 2), { mode: 0o600 });
} else {
  const ids = new Set<string>(), events = new Set<string>();
  let sql =
    "-- REVIEW REQUIRED. Not applied by this tool. Run only after separate production authorization.\nbegin;\n";
  for (const r of records) {
    if (
      !isObject(r) || typeof r.fcc_id !== "string" || !UUID.test(r.fcc_id) ||
      ids.has(r.fcc_id)
    ) throw Error("Invalid/repeated UUID");
    ids.add(r.fcc_id);
    if (r.decision === "link") {
      if (typeof r.event_id === "number" && !Number.isSafeInteger(r.event_id)) {
        throw Error("Use string IDs for bigint values");
      }
      const id = String(r.event_id);
      if (!/^\d+$/.test(id) || events.has(id)) {
        throw Error("Invalid/repeated internal ID");
      }
      events.add(id);
      sql +=
        `insert into furry_private.fcc_identity(fcc_id,event_id,mapping_kind) values ('${r.fcc_id}',${id},'reviewed_legacy');\n`;
    } else if (r.decision === "distinct") {
      if (typeof r.reason !== "string" || r.reason.trim().length < 20) {
        throw Error(
          "Distinct decision needs a specific review reason (>=20 chars)",
        );
      }
      sql +=
        `insert into furry_private.fcc_distinct_decisions(fcc_id,reason) values ('${r.fcc_id}','${
          r.reason.replaceAll("'", "''")
        }');\n`;
    } else {throw Error(
        "Every candidate requires an explicit link or distinct decision",
      );}
  }
  await writeFile(output, sql + "commit;\n", { mode: 0o600 });
}
