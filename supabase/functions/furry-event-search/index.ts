// deno-lint-ignore no-import-prefix -- pinned specifier works in standalone Edge bundles.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createSearchHandler } from "../_shared/handlers.ts";
import { readFilteredRows } from "../_shared/query_repository.ts";
const url = Deno.env.get("SUPABASE_URL")!;
Deno.serve(createSearchHandler({
  imageEndpoint: `${url}/functions/v1/furry-event-image`,
  readRows(payload, now) {
    const admin = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    return readFilteredRows(
      async (args) => {
        const { data, error } = await admin.rpc("read_fcc_event_page", args);
        if (error) throw Error("DATABASE_READ_FAILED");
        return data;
      },
      payload,
      now,
    );
  },
}));
