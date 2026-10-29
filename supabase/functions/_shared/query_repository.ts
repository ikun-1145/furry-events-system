import { type EventRow, searchRows } from "./public_events.ts";
import { isObject } from "./furry_event_contract.ts";
export function criteria(p: Record<string, unknown>, now: Date) {
  searchRows([], p, now);
  const d = new Date(now.getTime() + 8 * 3600000),
    month = p.month == null ? null : Number(p.month),
    year = p.year == null ? null : Number(p.year);
  const y = year ??
    (month !== null && month < d.getUTCMonth() + 1
      ? d.getUTCFullYear() + 1
      : d.getUTCFullYear());
  const date = (yy: number, mm: number) =>
    new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
  return {
    include_inactive: p.include_inactive === true,
    city: typeof p.city === "string"
      ? p.city.trim().toLowerCase().slice(0, 64)
      : "",
    start: month !== null
      ? date(y, month)
      : year !== null
      ? date(year, 1)
      : d.toISOString().slice(0, 10),
    end: month !== null
      ? date(y, month + 1)
      : year !== null
      ? date(year + 1, 1)
      : null,
    include_undated: month === null && year === null,
  };
}
export type ReadPage = (
  args: {
    p_criteria: ReturnType<typeof criteria>;
    p_after_id: string;
    p_limit: number;
  },
) => Promise<unknown>;
/** All database pages are collected within a single read-only RPC statement.
 * This prevents a source switch or sync commit from splitting one response. */
export async function readAtomicRows(
  read: (query: ReturnType<typeof criteria>) => Promise<unknown>,
  p: Record<string, unknown>,
  now: Date,
): Promise<EventRow[]> {
  const data = await read(criteria(p, now));
  if (!Array.isArray(data) || data.length > 10000) {
    throw Error("INVALID_DATABASE_PAGE");
  }
  let after = 0n;
  for (const e of data) {
    if (
      !isObject(e) || typeof e.id !== "string" || !/^\d+$/.test(e.id) ||
      BigInt(e.id) <= after
    ) throw Error("INVALID_DATABASE_ID");
    after = BigInt(e.id);
  }
  return data;
}
export async function readFilteredRows(
  read: ReadPage,
  p: Record<string, unknown>,
  now: Date,
): Promise<EventRow[]> {
  const c = criteria(p, now), rows: EventRow[] = [];
  let after = "0";
  for (let page = 0; page <= 100; page++) {
    const data = await read({ p_criteria: c, p_after_id: after, p_limit: 500 });
    if (!Array.isArray(data) || data.length > 500) {
      throw Error("INVALID_DATABASE_PAGE");
    }
    for (const e of data) {
      if (
        !isObject(e) || typeof e.id !== "string" || !/^\d+$/.test(e.id) ||
        BigInt(e.id) <= BigInt(after)
      ) throw Error("INVALID_DATABASE_ID");
      after = e.id;
      rows.push(e);
    }
    if (data.length < 500) return rows;
  }
  throw Error("QUERY_LIMIT_EXCEEDED");
}
