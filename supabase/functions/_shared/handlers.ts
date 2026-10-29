import {
  constantTimeEqual,
  ContractError,
  isObject,
} from "./furry_event_contract.ts";
import {
  boundedText,
  type FccSnapshot,
  fetchFccSnapshot,
} from "./fcc_adapter.ts";
import { type EventRow, publicEvent, searchRows } from "./public_events.ts";
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-function-secret, x-sync-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
function gate(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  // Deployment verify_jwt remains enabled. This is the original additional entry check.
  if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  return null;
}
async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await boundedText(new Response(req.body), 16384);
    const p: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!isObject(p)) throw Error();
    return p;
  } catch {
    throw new ContractError("INVALID_REQUEST", 400);
  }
}
export function createSyncHandler(
  deps: {
    secret: () => string;
    token: () => string;
    sync: (snapshot: FccSnapshot) => Promise<unknown>;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
) {
  return async (req: Request): Promise<Response> => {
    const rejected = gate(req);
    if (rejected) return rejected;
    const secret = deps.secret();
    if (
      !secret ||
      !constantTimeEqual(secret, req.headers.get("x-function-secret") ?? "")
    ) return json({ success: false, error: "INVALID_FUNCTION_SECRET" }, 403);
    try {
      const p = await body(req);
      if (p.allow_empty === true) {
        return json({ success: false, error: "EMPTY_OVERRIDE_DISABLED" }, 403);
      }
      const snapshot = await fetchFccSnapshot(deps.token(), {
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });
      // An empty inventory is not a successful replacement and must never call the DB.
      if (snapshot.events.length === 0) {
        throw new ContractError("FCC_EMPTY_SNAPSHOT", 409);
      }
      // PostgreSQL text/jsonb rejects U+0000 before the RPC can report a safe
      // error. Normalized events have only scalar fields; do not log content.
      if (snapshot.events.some((event) =>
        Object.values(event).some((value) =>
          typeof value === "string" && value.includes("\0")
        )
      )) throw new ContractError("FCC_POSTGRES_NUL", 422);
      const result = await deps.sync(snapshot);
      if (
        !isObject(result) || !Number.isSafeInteger(result.deactivated) ||
        Number(result.deactivated) < 0 ||
        result.upserted !== snapshot.events.length
      ) throw new ContractError("INVALID_SYNC_RESULT", 500);
      return json({
        success: true,
        source: "fcc",
        fetched: snapshot.events.length,
        ...result,
        errors: [],
      });
    } catch (e) {
      if (e instanceof ContractError) {
        const response = json({ success: false, error: e.code }, e.status);
        if (e.retryAfter && /^\d{1,12}$/.test(e.retryAfter)) {
          response.headers.set("Retry-After", e.retryAfter);
        }
        return response;
      }
      // Never include tokens, upstream bodies, raw SQL errors, or request headers.
      return json({ success: false, error: "FCC_SYNC_FAILED" }, 500);
    }
  };
}
export function createSearchHandler(
  deps: {
    readRows: (
      payload: Record<string, unknown>,
      now: Date,
    ) => Promise<EventRow[]>;
    imageEndpoint: string;
    now?: () => Date;
  },
) {
  return async (req: Request) => {
    const rejected = gate(req);
    if (rejected) return rejected;
    try {
      const p = await body(req);
      const now = deps.now?.() ?? new Date();
      searchRows([], p, now); // Validate before any DB read.
      const rows = searchRows(await deps.readRows(p, now), p, now);
      return json({
        events: rows.map((r) => publicEvent(r, deps.imageEndpoint)),
        total: rows.length,
        cached: false,
        cacheKey: null,
      });
    } catch (e) {
      return json(
        {
          error: e instanceof ContractError
            ? e.code
            : e instanceof Error && e.message === "INVALID_REQUEST"
            ? "INVALID_REQUEST"
            : "FURRY_EVENT_SEARCH_FAILED",
        },
        e instanceof ContractError
          ? e.status
          : e instanceof Error && e.message === "INVALID_REQUEST"
          ? 400
          : 500,
      );
    }
  };
}
