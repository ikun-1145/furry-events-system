import {
  isObject,
  UUID,
} from "../supabase/functions/_shared/furry_event_contract.ts";
type Row = Record<string, unknown>;
const norm = (v: unknown) =>
  typeof v === "string" ? v.trim().toLowerCase() : "";
function internalId(v: unknown): string {
  if (typeof v === "number" && !Number.isSafeInteger(v)) {
    throw Error("INVALID_ID");
  }
  const text = String(v);
  if (!/^\d+$/.test(text) || BigInt(text) > 9223372036854775807n) {
    throw Error("INVALID_ID");
  }
  return BigInt(text).toString();
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw Error("INVALID_ROWS");
  }
  return value;
}
export function classify(
  events: unknown,
  history: unknown,
  bindings: unknown = [],
) {
  for (const h of rows(history)) {
    if (
      !/^\d+$/.test(String(h.id)) ||
      typeof h.id === "number" && !Number.isSafeInteger(h.id) ||
      !norm(h.name) ||
      !(h.start_at === null ||
        typeof h.start_at === "string" &&
          Number.isFinite(Date.parse(h.start_at)))
    ) throw Error("INVALID_HISTORY");
  }
  const old = rows(history),
    bound = rows(bindings),
    seen = new Set<string>(),
    boundIds = new Set<string>(),
    map = new Map<string, string>();
  for (const b of bound) {
    const uuid = String(b.fcc_id).toLowerCase(), id = internalId(b.event_id);
    if (
      !UUID.test(uuid) || !/^\d+$/.test(id) || map.has(uuid) || boundIds.has(id)
    ) throw Error("INVALID_BINDINGS");
    map.set(uuid, id);
    boundIds.add(id);
  }
  return rows(events).map((e) => {
    const uuid = String(e.fcc_id).toLowerCase();
    if (
      !UUID.test(uuid) || seen.has(uuid) || !norm(e.name) ||
      !(e.start_at === null ||
        typeof e.start_at === "string" &&
          Number.isFinite(Date.parse(e.start_at)))
    ) throw Error("INVALID_EVENT");
    seen.add(uuid);
    const candidates = old.flatMap((h) => {
      const evidence: string[] = [];
      const a = norm(h.name), b = norm(e.name);
      if (a && a === b) evidence.push("name");
      else if (
        Array.from(a).length >= 3 && Array.from(b).length >= 3 &&
        (a.includes(b) || b.includes(a))
      ) evidence.push("name_overlap");
      if (
        norm(h.organization) && norm(h.organization) === norm(e.organization)
      ) evidence.push("organization");
      if (
        h.start_at && e.start_at &&
        String(h.start_at).slice(0, 10) === String(e.start_at).slice(0, 10)
      ) evidence.push("date");
      if (norm(h.city) && norm(h.city) === norm(e.city)) evidence.push("city");
      const credible = evidence.some((x) =>
        ["name", "name_overlap", "organization"].includes(x)
      ) || evidence.includes("date") && evidence.includes("city");
      return evidence.length
        ? [{ event_id: internalId(h.id), evidence, credible }]
        : [];
    });
    const existing = map.get(uuid);
    const risk = existing
      ? "bound"
      : candidates.some((c) => c.credible) || !norm(e.city) ||
          !norm(e.organization)
      ? "needs_review"
      : "new";
    return {
      ...e,
      fcc_id: uuid,
      risk,
      candidates,
      suggested_action: risk === "bound"
        ? "keep_binding"
        : risk === "new"
        ? "insert_via_sync"
        : "review_link_or_distinct",
      requires_confirmation: risk === "needs_review",
      decision: risk === "new" ? "new" : risk === "bound" ? "keep" : null,
      event_id: existing ?? null,
      reason: null,
    };
  });
}
export function mappingSql(input: unknown) {
  const list = rows(input),
    ids = new Set<string>(),
    internal = new Set<string>();
  let sql =
    "-- REVIEW ONLY: never automatically executed.\nbegin;\nset local standard_conforming_strings=on;\nselect pg_advisory_xact_lock(771284616231::bigint);\n";
  for (const r of list) {
    const uuid = String(r.fcc_id).toLowerCase();
    if (!UUID.test(uuid) || ids.has(uuid)) {
      throw Error("DUPLICATE_OR_INVALID_UUID");
    }
    ids.add(uuid);
    if (r.decision === "new" && r.risk === "new") continue;
    if (r.decision === "keep" && r.risk === "bound") {
      const id = internalId(r.event_id);
      sql +=
        `do $$ begin if not exists(select 1 from furry_private.fcc_identity where fcc_id='${uuid}' and event_id=${id}) then raise exception 'BINDING_CHANGED'; end if; end $$;\n`;
      continue;
    }
    if (r.risk === "bound") throw Error("REBIND_FORBIDDEN");
    if (r.decision === "link") {
      const id = internalId(r.event_id);
      if (
        typeof r.event_id === "number" && !Number.isSafeInteger(r.event_id) ||
        !/^\d+$/.test(id) || internal.has(id)
      ) throw Error("DUPLICATE_OR_INVALID_ID");
      internal.add(id);
      sql += `do $$ begin
 if exists(select 1 from furry_private.fcc_distinct_decisions where fcc_id='${uuid}') or exists(select 1 from furry_private.fcc_identity where (fcc_id='${uuid}' and event_id<>${id}) or (event_id=${id} and fcc_id<>'${uuid}')) then raise exception 'MAPPING_CONFLICT'; end if;
 insert into furry_private.fcc_identity(fcc_id,event_id,mapping_kind) values('${uuid}',${id},'reviewed_legacy') on conflict(fcc_id) do nothing;
end $$;\n`;
    } else if (r.decision === "distinct") {
      if (
        typeof r.reason !== "string" || r.reason.trim().length < 20 ||
        r.reason.includes("\0") || r.reason.includes("$$")
      ) throw Error("REVIEW_REASON_REQUIRED");
      const reason = r.reason.replaceAll("'", "''");
      sql += `do $$ begin
 if exists(select 1 from furry_private.fcc_identity where fcc_id='${uuid}') or exists(select 1 from furry_private.fcc_distinct_decisions where fcc_id='${uuid}' and reason<>'${reason}') then raise exception 'MAPPING_CONFLICT'; end if;
 insert into furry_private.fcc_distinct_decisions values('${uuid}','${reason}') on conflict(fcc_id) do nothing;
end $$;\n`;
    } else throw Error("REVIEW_REQUIRED");
  }
  return sql + "commit;\n";
}
