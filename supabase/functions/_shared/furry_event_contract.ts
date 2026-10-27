/** Public compatibility contract. Ingestion metadata never belongs in this shape. */
export const LEGACY_SOURCE = "furfantasia_event_data";
export const FCC_SOURCE = "fcc";
export const FCC_STATUSES = [
  "cancelled",
  "movedOnline",
  "postponed",
  "rescheduled",
  "scheduled",
] as const;
export type FccStatus = typeof FCC_STATUSES[number];
export type FurryEvent = {
  fcc_id: string;
  name: string;
  full_name: string;
  start_at: string | null;
  end_at: string | null;
  province: string | null;
  city: string | null;
  address: string | null;
  venue: string | null;
  cover: string | null;
  source_url: string | null;
  detail: string | null;
  organization: string | null;
  native_status: string;
  status_known: boolean;
};
export class ContractError extends Error {
  constructor(
    public code: string,
    public status = 502,
    public retryAfter?: string,
  ) {
    super(code);
  }
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length, 1); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const STATUS_LABELS: Record<string, string> = {
  cancelled: "已取消",
  movedOnline: "线上举办",
  postponed: "已延期",
  rescheduled: "已改期",
  scheduled: "已安排",
};
/** Only FCC-owned media/detail origins. No credentials, redirects or arbitrary hosts. */
export function fccUrl(
  value: unknown,
  kind: "image" | "detail",
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const base = kind === "image"
      ? "https://images.furrycons.cn/"
      : "https://www.furrycons.cn/";
    const u = new URL(value, base);
    const hosts = kind === "image"
      ? ["images.furrycons.cn"]
      : ["furrycons.cn", "www.furrycons.cn"];
    if (
      u.protocol !== "https:" || u.username || u.password || u.port ||
      !hosts.includes(u.hostname)
    ) return null;
    return u.href;
  } catch {
    return null;
  }
}
/** Canonical Shanghai wall time keeps existing text-column range queries compatible. */
export function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value)
  ) throw new ContractError("FCC_INVALID_DATE");
  if (
    Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  ) throw new ContractError("FCC_INVALID_DATE");
  const day = value.slice(0, 10), [y, m, d] = day.split("-").map(Number);
  if (
    new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== day ||
    !Number.isFinite(Date.parse(value))
  ) throw new ContractError("FCC_INVALID_DATE");
  const shifted = new Date(Date.parse(value) + 8 * 3600000).toISOString();
  return shifted.slice(0, 19) +
    (shifted.slice(19, 23) === ".000" ? "" : shifted.slice(19, 23)) + "+08:00";
}
