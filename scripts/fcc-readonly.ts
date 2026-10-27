/** No Supabase client, RPC, SQL, function invocation, or production database access. */
import {
  boundedText,
  fetchFccSnapshot,
} from "../supabase/functions/_shared/fcc_adapter.ts";
import {
  ContractError,
  fccUrl,
} from "../supabase/functions/_shared/furry_event_contract.ts";
type Row = Record<string, unknown>;
export function historicalCandidates(history: Row[], events: Row[] | null) {
  return history.map((old) => ({
    id: old.id,
    name: old.name,
    start_at: old.start_at,
    is_active: old.is_active,
    assessment: events === null
      ? "NOT_VERIFIED_NO_FCC_SAMPLE"
      : "REVIEW_REQUIRED",
    candidates: events === null ? null : events.flatMap((e) => {
      const reasons: string[] = [];
      if (
        String(old.name).trim().toLowerCase() ===
          String(e.name).trim().toLowerCase()
      ) reasons.push("name");
      if (
        old.start_at && e.start_at &&
        String(old.start_at).slice(0, 10) === String(e.start_at).slice(0, 10)
      ) reasons.push("date");
      if (old.organization && old.organization === e.organization) {
        reasons.push("organization");
      }
      if (!reasons.length) return [];
      return [{
        fcc_id: e.fcc_id,
        name: e.name,
        start_at: e.start_at,
        city: e.city,
        organization: e.organization,
        reasons,
        confidence: reasons.includes("name") && reasons.includes("date")
          ? "strong_candidate_not_identity_proof"
          : "weak_candidate",
        decision: null,
      }];
    }),
  }));
}
export async function inspectFcc(
  token: string,
  history: Row[],
  fetchImpl: typeof fetch = fetch,
) {
  const now = new Date().toISOString();
  const base = {
    generated_at: now,
    mode: "read_only_no_database",
    historical_count: history.length,
    active_historical_count: history.filter((r) => r.is_active === true).length,
  };
  if (!token.trim()) {
    return {
      ...base,
      status: "BLOCKED_TOKEN_NOT_AVAILABLE",
      real_api_verified: false,
      history: historicalCandidates(history, null),
      events: [],
    };
  }
  const observedImages = new Set<string>(), observedDetails = new Set<string>();
  // Observe raw URL host forms, never output authorization or arbitrary response bodies.
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== "https://api.furrycons.cn" ||
      url.pathname !== "/open/event" || (init?.method ?? "GET") !== "GET"
    ) throw new ContractError("READONLY_ORIGIN_DENIED");
    const r = await fetchImpl(input, init);
    if (r.ok) {
      const text = await boundedText(r);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (data && Array.isArray(data.data)) {
        for (const e of data.data) {
          for (
            const [value, set] of [[e.thumbnail, observedImages], [
              e.url,
              observedDetails,
            ]] as const
          ) {
            if (typeof value === "string" && value) {
              try {
                set.add(new URL(value).hostname);
              } catch {
                set.add("RELATIVE_PATH");
              }
            }
          }
        }
      }
      return new Response(text, { status: r.status, headers: r.headers });
    }
    return r;
  };
  try {
    const snapshot = await fetchFccSnapshot(token, {
      fetchImpl: observedFetch,
    });
    const probes = [];
    // Bounded sample: HEAD only, no token, no redirects; no unknown origins are contacted.
    for (const kind of ["image", "detail"] as const) {
      const urls = [
        ...new Set(
          snapshot.events.map((e) => kind === "image" ? e.cover : e.source_url)
            .filter((x): x is string => x !== null),
        ),
      ].slice(0, 10);
      for (const value of urls) {
        const url = fccUrl(value, kind);
        if (!url) continue;
        try {
          const r = await fetchImpl(url, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
          });
          await r.body?.cancel();
          const type = r.headers.get("content-type") ?? "";
          probes.push({
            kind,
            host: new URL(url).hostname,
            status: r.status,
            content_type: type,
            usable: r.ok && (kind === "detail" || /^image\//.test(type)),
            redirect: r.status >= 300 && r.status < 400,
          });
        } catch {
          probes.push({
            kind,
            host: new URL(url).hostname,
            error: "RESOURCE_PROBE_FAILED",
            usable: false,
          });
        }
      }
    }
    const states: Record<string, number> = {};
    for (const e of snapshot.events) {
      states[e.native_status] = (states[e.native_status] ?? 0) + 1;
    }
    const report = {
      ...base,
      status: "API_SCHEMA_AND_PAGINATION_PASSED",
      real_api_verified: true,
      pages_per_pass: snapshot.pages,
      passes: 2,
      event_count: snapshot.events.length,
      null_start_dates: snapshot.events.filter((e) =>
        e.start_at === null
      ).length,
      states,
      unknown_states: snapshot.events.filter((e) => !e.status_known).map((e) =>
        e.native_status
      ),
      raw_image_hosts: [...observedImages],
      raw_detail_hosts: [...observedDetails],
      resource_probes: probes,
      resource_check_limit:
        "HEAD sample <=10 images and <=10 detail URLs; not a browser/image decode check",
      suppressed_images: snapshot.events.filter((e) => !e.cover).length,
      suppressed_details: snapshot.events.filter((e) => !e.source_url).length,
      history: historicalCandidates(history, snapshot.events),
      events: snapshot.events,
    };
    // A malicious upstream must not cause exact credential text to enter an artifact.
    return JSON.parse(JSON.stringify(report).replaceAll(token, "[REDACTED]"));
  } catch (e) {
    return {
      ...base,
      status: "API_VALIDATION_FAILED",
      real_api_verified: false,
      error: e instanceof ContractError ? e.code : "READONLY_CHECK_FAILED",
      history: historicalCandidates(history, null),
      events: [],
    };
  }
}
