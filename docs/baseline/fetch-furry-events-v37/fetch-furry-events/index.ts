import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  ContractError,
  FURRY_EVENT_SOURCE,
  constantTimeEqual,
  parseAllowEmpty,
  shouldRejectEmptySnapshot,
  validateEmptyOverride,
  validateWorkerPayload,
  type FurryEvent,
} from "../_shared/furry_event_contract.ts";

const WORKER_URL = "https://sunland-data-worker.liuxizekali.workers.dev";
const FURRYFUSION_API_URL = "https://api.furryfusion.net/service/activity";
const FURRYFUSION_SITE_URL = "https://www.furryfusion.net";
const REQUEST_TIMEOUT_MS = 20_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-function-secret, x-sync-trigger",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SnapshotSource = "worker" | "direct";

type SnapshotResult = {
  events: FurryEvent[];
  source: SnapshotSource;
  workerFailure?: Record<string, unknown>;
};

type ExistingEvent = {
  source_id: string | null;
  name: string;
  start_at: string | null;
  venue: string | null;
  detail: string | null;
  organization: string | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function emptySnapshotResponse(active: number): Response {
  return jsonResponse({
    success: false,
    error: "EMPTY_SNAPSHOT_REJECTED",
    message: "An empty snapshot cannot replace existing active events",
    details: { active },
  }, 409);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ContractError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: error.name || "ERROR", message: error.message };
  }
  return { code: "ERROR", message: String(error) };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError("INVALID_REQUEST", "Request body must be valid JSON");
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response: Response, source: string): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    throw new ContractError("UPSTREAM_SCHEMA_INVALID", `${source} returned an empty response`, {
      status: response.status,
      content_type: response.headers.get("content-type"),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ContractError("UPSTREAM_SCHEMA_INVALID", `${source} response is not valid JSON`, {
      status: response.status,
      content_type: response.headers.get("content-type"),
    });
  }
}

async function fetchWorkerSnapshot(): Promise<FurryEvent[]> {
  const response = await fetchWithTimeout(WORKER_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response, "Worker");
  if (!response.ok) {
    throw new ContractError("WORKER_REQUEST_FAILED", `Worker returned HTTP ${response.status}`, {
      upstream: isObject(payload) ? payload : {},
    });
  }
  return validateWorkerPayload(payload);
}

function requiredString(item: Record<string, unknown>, key: string, index: number): string {
  const value = item[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", `FurryFusion item has invalid ${key}`, { index });
  }
  return value.trim();
}

function normalizeDate(value: string, key: string, index: number): string {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(value)) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", `FurryFusion item has invalid ${key}`, { index });
  }
  const normalized = `${value.replaceAll(".", "-")}T00:00:00+08:00`;
  if (Number.isNaN(Date.parse(normalized))) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", `FurryFusion item has invalid ${key}`, { index });
  }
  return normalized;
}

function splitAddress(address: string): { province: string | null; city: string | null } {
  const separator = address.indexOf("·");
  if (separator < 0) return { province: address || null, city: null };
  const province = address.slice(0, separator).trim();
  const city = address.slice(separator + 1).trim();
  return { province: province || null, city: city || null };
}

function sourceStateText(state: number): string | null {
  return ["活动结束", "预告中", "售票中", "活动中", "活动取消"][state] ?? null;
}

function publicStatus(state: number): "preview" | "confirmed" | null {
  if (state === 1) return "preview";
  if (state === 2 || state === 3) return "confirmed";
  return null;
}

function convertDirectItem(raw: unknown, index: number, updatedAt: string): FurryEvent {
  if (!isObject(raw)) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", "FurryFusion item must be an object", { index });
  }
  const organization = requiredString(raw, "title", index);
  const name = requiredString(raw, "name", index);
  const address = requiredString(raw, "address", index);
  const startAt = normalizeDate(requiredString(raw, "time_start", index), "time_start", index);
  const endAt = normalizeDate(requiredString(raw, "time_end", index), "time_end", index);
  const sourcePath = requiredString(raw, "path", index);
  const cover = requiredString(raw, "image", index);
  const state = raw.state;
  if (typeof state !== "number" || !Number.isInteger(state) || state < 0 || state > 4) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", "FurryFusion item has invalid state", { index });
  }
  if (!sourcePath.startsWith("/fusion/")) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", "FurryFusion item has invalid path", { index });
  }
  if (Date.parse(endAt) < Date.parse(startAt)) {
    throw new ContractError("DIRECT_UPSTREAM_CONTRACT_INVALID", "FurryFusion item ends before it starts", { index });
  }
  const location = splitAddress(address);
  return {
    source_id: `furryfusion:${startAt.slice(0, 10)}:${sourcePath}:${name}`,
    name,
    full_name: `${organization}·${name}`,
    start_at: startAt,
    end_at: endAt,
    province: location.province,
    city: location.city,
    address,
    venue: null,
    cover,
    status: publicStatus(state),
    source_state: state,
    source_state_text: sourceStateText(state),
    source_url: new URL(sourcePath, FURRYFUSION_SITE_URL).toString(),
    source_path: sourcePath,
    detail: null,
    organization,
    updated_at: updatedAt,
  };
}

async function fetchDirectSnapshot(): Promise<FurryEvent[]> {
  const response = await fetchWithTimeout(FURRYFUSION_API_URL, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      Origin: FURRYFUSION_SITE_URL,
      Referer: `${FURRYFUSION_SITE_URL}/`,
    },
    cache: "no-store",
  });
  const payload = await parseJsonResponse(response, "FurryFusion");
  if (!response.ok) {
    throw new ContractError("DIRECT_UPSTREAM_REQUEST_FAILED", `FurryFusion returned HTTP ${response.status}`);
  }
  if (!isObject(payload) || payload.code !== "OK" || !Array.isArray(payload.data)) {
    throw new ContractError(
      "DIRECT_UPSTREAM_CONTRACT_INVALID",
      "FurryFusion response must contain code=OK and a data array",
    );
  }
  const updatedAt = new Date().toISOString();
  const events = payload.data.map((item, index) => convertDirectItem(item, index, updatedAt));
  return validateWorkerPayload({ events });
}

async function loadSnapshot(): Promise<SnapshotResult> {
  let workerFailure: Record<string, unknown>;
  try {
    return { events: await fetchWorkerSnapshot(), source: "worker" };
  } catch (error) {
    workerFailure = errorDetails(error);
    console.warn(JSON.stringify({
      level: "warning",
      code: "FURRY_EVENT_WORKER_FALLBACK",
      worker: workerFailure,
    }));
  }
  try {
    return { events: await fetchDirectSnapshot(), source: "direct", workerFailure };
  } catch (error) {
    throw new ContractError(
      "FURRY_EVENT_SOURCES_UNAVAILABLE",
      "Both the Worker and direct FurryFusion source failed",
      { worker: workerFailure, direct: errorDetails(error) },
    );
  }
}

function eventKey(name: string, startAt: string): string {
  return `${name}\u0000${startAt}`;
}

function preserveExistingEnrichment(events: FurryEvent[], existing: ExistingEvent[]): FurryEvent[] {
  const byKey = new Map<string, ExistingEvent>();
  for (const item of existing) {
    if (item.start_at) byKey.set(eventKey(item.name, item.start_at), item);
  }
  return events.map((event) => {
    const previous = byKey.get(eventKey(event.name, event.start_at));
    if (!previous) return event;
    return {
      ...event,
      source_id: previous.source_id || event.source_id,
      venue: previous.venue ?? event.venue,
      detail: previous.detail ?? event.detail,
      organization: previous.organization ?? event.organization,
    };
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ success: false, error: "METHOD_NOT_ALLOWED", message: "Only POST is supported" }, 405);
  }
  if (!request.headers.get("Authorization")?.startsWith("Bearer ")) {
    return jsonResponse({ success: false, error: "UNAUTHORIZED", message: "A valid bearer token is required" }, 401);
  }

  const expectedSecret = Deno.env.get("FUNCTION_SECRET") ?? "";
  const suppliedSecret = request.headers.get("x-function-secret") ?? "";
  if (!expectedSecret || !constantTimeEqual(suppliedSecret, expectedSecret)) {
    return jsonResponse({ success: false, error: "INVALID_FUNCTION_SECRET", message: "Function secret validation failed" }, 403);
  }

  try {
    const allowEmpty = parseAllowEmpty(await readJsonBody(request));
    const trigger = (request.headers.get("x-sync-trigger") ?? "").trim().toLowerCase();
    validateEmptyOverride(allowEmpty, trigger);

    const snapshot = await loadSnapshot();
    let events = snapshot.events;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Supabase service configuration is unavailable");
    }
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: existingEvents, error: existingError } = await admin
      .from("furry_events")
      .select("source_id,name,start_at,venue,detail,organization")
      .eq("source", FURRY_EVENT_SOURCE);
    if (existingError) throw existingError;
    if (snapshot.source === "direct") {
      events = preserveExistingEnrichment(events, (existingEvents ?? []) as ExistingEvent[]);
      events = validateWorkerPayload({ events });
    }

    const { count: activeCount, error: activeError } = await admin
      .from("furry_events")
      .select("id", { count: "exact", head: true })
      .eq("source", FURRY_EVENT_SOURCE)
      .eq("is_active", true);
    if (activeError) throw activeError;
    if (shouldRejectEmptySnapshot(events.length, activeCount ?? 0, allowEmpty)) {
      return emptySnapshotResponse(activeCount ?? 0);
    }

    const syncedAt = new Date().toISOString();
    const { data, error } = await admin.rpc("sync_furry_events", {
      events,
      synced_at: syncedAt,
      allow_empty: allowEmpty,
    });
    if (error) {
      if (`${error.message} ${error.details ?? ""}`.includes("EMPTY_SNAPSHOT_REJECTED")) {
        return emptySnapshotResponse(activeCount ?? 0);
      }
      throw error;
    }
    const result = Array.isArray(data) ? data[0] : data;
    if (!result || typeof result !== "object") {
      throw new Error("sync_furry_events returned an invalid result");
    }
    return jsonResponse({
      success: true,
      source: snapshot.source,
      fetched: events.length,
      upserted: Number(result.upserted ?? 0),
      deactivated: Number(result.deactivated ?? 0),
      active: Number(result.active ?? 0),
      inactive: Number(result.inactive ?? 0),
      errors: [],
    });
  } catch (error) {
    if (error instanceof ContractError) {
      const isForbidden = error.code === "SCHEDULED_EMPTY_OVERRIDE_FORBIDDEN"
        || error.code === "ALLOW_EMPTY_REQUIRES_MANUAL_TRIGGER";
      return jsonResponse({
        success: false,
        error: error.code,
        message: error.message,
        details: error.details,
      }, isForbidden ? 403 : error.code === "INVALID_REQUEST" ? 400 : 502);
    }
    console.error(JSON.stringify({
      level: "error",
      code: "FURRY_EVENT_SYNC_FAILED",
      message: error instanceof Error ? error.message : String(error),
    }));
    return jsonResponse({
      success: false,
      error: "FURRY_EVENT_SYNC_FAILED",
      message: "The furry event snapshot could not be synchronized",
      details: {},
    }, 500);
  }
});
