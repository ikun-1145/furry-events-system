import {
  FCC_SOURCE,
  fccUrl,
  type FurryEvent,
  isObject,
  LEGACY_SOURCE,
  STATUS_LABELS,
} from "./furry_event_contract.ts";
export const PLACEHOLDER_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#edf2f7"/><circle cx="400" cy="190" r="50" fill="#94a3b8"/><text x="400" y="300" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#334155">活动图片暂不可用</text></svg>`;
export type EventRow = Record<string, unknown>;
export function scrubText(value: unknown): string | null {
  return typeof value === "string"
    ? value.replace(
      /https?:\/\/[^\s<>"']*furryfusion\.net[^\s<>"']*/gi,
      "[retired link]",
    )
    : null;
}
export function publicEvent(
  row: EventRow,
  imageEndpoint: string,
): Record<string, unknown> {
  const image = fccUrl(row.cover ?? row.cover_url, "image");
  const cover = image
    ? `${imageEndpoint}?url=${encodeURIComponent(image)}`
    : imageEndpoint;
  const native = typeof row.native_status === "string"
    ? row.native_status
    : null;
  const rawStatus = native
    ? (STATUS_LABELS[native] ?? "状态待确认")
    : scrubText(row.source_state_text ?? row.raw_status ?? row.status);
  const start = typeof row.start_at === "string" && row.start_at
    ? row.start_at
    : null;
  const end = typeof row.end_at === "string" && row.end_at ? row.end_at : null;
  return {
    id: row.id,
    source_id: row.source_id,
    name: scrubText(row.name),
    full_name: scrubText(row.full_name),
    start_at: start,
    end_at: end,
    startAt: start ?? "时间待定",
    endAt: end ?? "时间待定",
    date_pending: start === null,
    province: scrubText(row.province),
    city: scrubText(row.city),
    address: scrubText(row.address),
    venue: scrubText(row.venue),
    cover,
    cover_url: cover,
    coverUrl: cover,
    detail_available: fccUrl(row.source_url, "detail") !== null,
    detail_link_status: fccUrl(row.source_url, "detail")
      ? "available"
      : "unavailable",
    detail_link_text: fccUrl(row.source_url, "detail")
      ? "活动详情"
      : "暂无详情链接",
    source_url: fccUrl(row.source_url, "detail"),
    sourceUrl: fccUrl(row.source_url, "detail"),
    status: native ?? row.status ?? null,
    native_status: native,
    status_known: row.status_known ?? null,
    raw_status: rawStatus,
    rawStatus,
    source_state: native ? null : row.source_state ?? null,
    source_state_text: rawStatus,
    detail: scrubText(row.detail),
    organization: scrubText(row.organization),
    updated_at: row.updated_at ?? null,
  };
}
export function searchRows(
  rows: EventRow[],
  payload: Record<string, unknown>,
  now: Date,
): EventRow[] {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  const currentYear = shifted.getUTCFullYear(),
    currentMonth = shifted.getUTCMonth() + 1;
  const month = payload.month == null ? null : Number(payload.month),
    year = payload.year == null ? null : Number(payload.year);
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    throw Error("INVALID_REQUEST");
  }
  if (
    year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)
  ) throw Error("INVALID_REQUEST");
  if (payload.city != null && typeof payload.city !== "string") {
    throw Error("INVALID_REQUEST");
  }
  const city = typeof payload.city === "string"
    ? payload.city.trim().toLowerCase().slice(0, 64)
    : "";
  const resolvedYear = year ??
    (month !== null && month < currentMonth ? currentYear + 1 : currentYear);
  return rows.filter((r) => {
    if (![FCC_SOURCE, LEGACY_SOURCE, "legacy"].includes(String(r.source))) {
      return false;
    }
    if (payload.include_inactive !== true && r.is_active !== true) return false;
    if (
      city &&
      ![r.address, r.province, r.city].some((v) =>
        typeof v === "string" && v.toLowerCase().includes(city)
      )
    ) return false;
    const date = typeof r.start_at === "string"
      ? r.start_at.slice(0, 10)
      : null;
    if (!date) return month === null && year === null;
    if (month !== null) {
      return date.startsWith(
        `${resolvedYear}-${String(month).padStart(2, "0")}-`,
      );
    }
    if (year !== null) return date.startsWith(`${year}-`);
    return date >= shifted.toISOString().slice(0, 10);
  }).sort((a, b) =>
    String(a.start_at ?? "9999").localeCompare(String(b.start_at ?? "9999")) ||
    String(a.id).localeCompare(String(b.id))
  );
}
export function validQuery(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}
export function imageUrlForEvent(event: FurryEvent): string | null {
  return fccUrl(event.cover, "image");
}
