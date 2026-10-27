import {
  ContractError,
  FCC_STATUSES,
  fccUrl,
  type FurryEvent,
  isObject,
  timestamp,
  UUID,
} from "./furry_event_contract.ts";
const API = "https://api.furrycons.cn/open/event";
const MAX_BYTES = 4 * 1024 * 1024;
export async function boundedText(
  response: Response,
  maxBytes = MAX_BYTES,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        throw new ContractError("UPSTREAM_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(all);
}
function str(
  v: unknown,
  key: string,
  required = false,
  max = 20000,
): string | null {
  if (v === null && !required) return null;
  if (
    typeof v !== "string" || v.length > max ||
    Array.from(v).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  ) throw new ContractError("FCC_INVALID_" + key.toUpperCase());
  const s = v.trim();
  if (required && !s) {
    throw new ContractError("FCC_INVALID_" + key.toUpperCase());
  }
  return s || null;
}
export function normalizeFccEvent(raw: unknown): FurryEvent {
  if (!isObject(raw) || typeof raw.id !== "string" || !UUID.test(raw.id)) {
    throw new ContractError("FCC_INVALID_ID");
  }
  const name = str(raw.name, "name", true, 300)!;
  const status = str(raw.status, "status", true, 100)!;
  const start = timestamp(raw.startDate), end = timestamp(raw.endDate);
  if (start && end && Date.parse(end) < Date.parse(start)) {
    throw new ContractError("FCC_INVALID_DATE_RANGE");
  }
  if (!isObject(raw.place) || !isObject(raw.organization)) {
    throw new ContractError("FCC_INVALID_RELATION");
  }
  const address = str(raw.address, "address", false, 1000),
    region = str(raw.region, "region", false, 300);
  const thumb = str(raw.thumbnail, "thumbnail", false, 2048),
    url = str(raw.url, "url", false, 2048);
  const org = raw.organization.name === undefined
    ? null
    : str(raw.organization.name, "organization", false, 300);
  const venue = raw.place.name === undefined
    ? null
    : str(raw.place.name, "place", false, 1000);
  if (raw.place.address !== undefined) {
    str(raw.place.address, "place_address", false, 1000);
  }
  // Region's decomposition is undocumented. Keep the full value, don't guess province/city.
  return {
    fcc_id: raw.id.toLowerCase(),
    name,
    full_name: name,
    start_at: start,
    end_at: end,
    province: null,
    city: region,
    address,
    venue,
    cover: fccUrl(thumb, "image"),
    source_url: fccUrl(url, "detail"),
    detail: str(raw.detail, "detail")?.replace(
      /https?:\/\/[^\s<>"']*furryfusion\.net[^\s<>"']*/gi,
      "[retired link]",
    ) ?? null,
    organization: org,
    native_status: status,
    status_known: (FCC_STATUSES as readonly string[]).includes(status),
  };
}
type Page = {
  total: number;
  current: number;
  pageSize: number;
  data: unknown[];
};
function page(
  raw: unknown,
  expectedPage: number,
  size: number,
  expectedTotal?: number,
): Page {
  if (
    !isObject(raw) || ("info" in raw && raw.info != null && raw.info !== "") ||
    ("success" in raw && raw.success !== true) ||
    ("error" in raw && raw.error != null)
  ) throw new ContractError("FCC_BUSINESS_ERROR");
  if (
    !Number.isSafeInteger(raw.total) || Number(raw.total) < 0 ||
    raw.current !== expectedPage || raw.pageSize !== size ||
    !Array.isArray(raw.data)
  ) throw new ContractError("FCC_INVALID_PAGE");
  const total = Number(raw.total);
  if (
    total > 10000 || (expectedTotal !== undefined && total !== expectedTotal)
  ) throw new ContractError("FCC_PAGE_DRIFT");
  const count = Math.max(0, Math.min(size, total - (expectedPage - 1) * size));
  if (raw.data.length !== count) throw new ContractError("FCC_INCOMPLETE_PAGE");
  return { total, current: expectedPage, pageSize: size, data: raw.data };
}
export type FccSnapshot = {
  events: FurryEvent[];
  complete: true;
  started_at: string;
  completed_at: string;
  pages: number;
};
/** Two identical complete passes detect moving pagination without an upstream snapshot cursor.
 * Never claims an upstream transactional snapshot. No absence deactivation is allowed. */
export async function fetchFccSnapshot(
  token: string,
  options: { fetchImpl?: typeof fetch; now?: () => Date; pageSize?: number } =
    {},
): Promise<FccSnapshot> {
  if (!token.trim()) throw new ContractError("FCC_TOKEN_NOT_CONFIGURED", 503);
  const fetchImpl = options.fetchImpl ?? fetch,
    now = options.now ?? (() => new Date()),
    size = options.pageSize ?? 20;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) {
    throw new ContractError("FCC_INVALID_PAGE_SIZE");
  }
  const started_at = now().toISOString();
  async function pass() {
    let total: number | undefined;
    const events: FurryEvent[] = [];
    const ids = new Set<string>();
    let pages = 0;
    do {
      const current = ++pages;
      const u = new URL(API);
      u.searchParams.set("current", String(current));
      u.searchParams.set("pageSize", String(size));
      let response: Response;
      try {
        response = await fetchImpl(u, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw new ContractError("FCC_NETWORK_ERROR");
      }
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        const retry = response.headers.get("Retry-After");
        const reset = response.headers.get("X-RateLimit-Reset");
        // Retry-After is seconds; an epoch reset must never be forwarded as seconds.
        let retryAfter: string | undefined;
        if (retry && /^\d+$/.test(retry) && Number(retry) <= 86400) {
          retryAfter = retry;
        } else if (reset && /^\d{10}(?:\.\d+)?$/.test(reset)) {
          const wait = Math.ceil(Number(reset) - Date.now() / 1000);
          if (wait >= 0 && wait <= 86400) retryAfter = String(wait);
        }
        throw new ContractError(
          status === 401 || status === 403
            ? "FCC_AUTH_FAILED"
            : status === 429
            ? "FCC_RATE_LIMITED"
            : "FCC_HTTP_ERROR",
          status === 429 ? 429 : 502,
          retryAfter,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await boundedText(response));
      } catch (e) {
        if (e instanceof ContractError) throw e;
        throw new ContractError("FCC_INVALID_JSON");
      }
      const p = page(raw, current, size, total);
      total = p.total;
      for (const r of p.data) {
        const e = normalizeFccEvent(r);
        if (ids.has(e.fcc_id)) throw new ContractError("FCC_DUPLICATE_ID");
        ids.add(e.fcc_id);
        events.push(e);
      }
    } while (events.length < total!);
    return {
      events: events.sort((a, b) => a.fcc_id.localeCompare(b.fcc_id)),
      pages,
    };
  }
  const first = await pass(), second = await pass();
  if (JSON.stringify(first.events) !== JSON.stringify(second.events)) {
    throw new ContractError("FCC_SNAPSHOT_DRIFT");
  }
  return {
    ...second,
    complete: true,
    started_at,
    completed_at: now().toISOString(),
  };
}
