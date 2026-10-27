// deno-lint-ignore no-import-prefix -- pinned specifier works in standalone Edge bundles.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createSearchHandler } from "../_shared/handlers.ts";
const url = Deno.env.get("SUPABASE_URL")!;
Deno.serve(createSearchHandler({
  imageEndpoint: `${url}/functions/v1/furry-event-image`,
  async readRows() {
    const admin = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const rows: Record<string, unknown>[] = [];
    // Fetch every DB page; do not silently truncate the old clients' response at 1000.
    for (let offset = 0; offset <= 50000; offset += 500) {
      const { data, error } = await admin.from("furry_events").select(
        "id::text,source,source_id,name,full_name,start_at,end_at,province,city,address,venue,cover,cover_url,status,native_status,status_known,source_state,source_state_text,source_url,detail,organization,updated_at,is_active",
      ).in("source", ["fcc", "furfantasia_event_data", "legacy"]).order("id")
        .range(offset, offset + 499);
      if (error) throw Error("DATABASE_READ_FAILED");
      rows.push(...data);
      if (data.length < 500) return rows;
    }
    throw Error("QUERY_LIMIT_EXCEEDED");
  },
}));
