// deno-lint-ignore no-import-prefix -- pinned specifier works in standalone Edge bundles.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { ContractError } from "../_shared/furry_event_contract.ts";
import { createSyncHandler } from "../_shared/handlers.ts";
const handler = createSyncHandler({
  secret: () => Deno.env.get("FUNCTION_SECRET") ?? "",
  token: () => Deno.env.get("FCC_API_TOKEN") ?? "",
  // Fewer requests while preserving two independent complete snapshot passes.
  pageSize: 50,
  async sync(snapshot) {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await admin.rpc("sync_fcc_events", {
      events: snapshot.events,
      started_at: snapshot.started_at,
      completed_at: snapshot.completed_at,
      complete: snapshot.complete,
    });
    if (error) {
      const safeCodes = [
        "STALE_SNAPSHOT",
        "INCOMPLETE_SNAPSHOT",
      ];
      const code = safeCodes.find((code) => error.message === code);
      if (code) throw new ContractError(code, 409);
      throw Error("DATABASE_SYNC_FAILED");
    }
    return data;
  },
});
Deno.serve(handler);
