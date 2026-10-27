import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeFccEvent } from "../../supabase/functions/_shared/fcc_adapter.ts";
import { id, raw } from "../fixtures.ts";
let server: EmbeddedPostgres, db: pg.Client, dir: string;
const port = 55439;
const connect = () =>
  new pg.Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "local-test-only",
    database: "postgres",
  });
const migration = await readFile(
  new URL(
    "../../supabase/migrations/20261027061449_fcc_safe_ingestion.sql",
    import.meta.url,
  ),
  "utf8",
);
const shape = await readFile(
  new URL("./production-shape.sql", import.meta.url),
  "utf8",
);
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fcc-pg-"));
  server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "local-test-only",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  db = connect();
  await db.connect();
});
after(async () => {
  await db?.end();
  await server?.stop();
  if (dir) await rm(dir, { force: true, recursive: true });
});
beforeEach(async () => {
  await db.query(
    "drop schema if exists furry_private cascade; drop schema public cascade; create schema public;",
  );
  const roles = await db.query("select 1 from pg_roles where rolname='anon'");
  await db.query(
    roles.rowCount ? shape.replace(/CREATE ROLE [^;]+;/g, "") : shape,
  );
  await db.query(
    `insert into public.furry_events(id,name,source_id,source,start_at,status,is_active,cover,source_url,venue,detail)
 select n,'历史'||n,'duplicate_legacy_id','furfantasia_event_data','2026-11-01T00:00:00+08:00','preview',n<=8,'https://image.furryfusion.net/x','https://www.furryfusion.net/x','保留场所','保留详情' from generate_series(1,32)n;
 select setval('public.furry_events_id_seq',32,true);`,
  );
  await db.query(migration);
});
const start = (n: number) => `2026-10-27T00:00:${String(n).padStart(2, "0")}Z`;
async function sync(client: pg.Client, events: unknown[], n = 1) {
  return (await client.query(
    "select public.sync_fcc_events($1::jsonb,$2,$3,true) result",
    [JSON.stringify(events), start(n), start(n)],
  )).rows[0].result;
}
const event = (n = 1, change: Record<string, unknown> = {}) =>
  normalizeFccEvent(raw(n, change));
test("migration preserves all 32 IDs, activation and useful history; no public retired URLs", async () => {
  const r = await db.query("select * from public.furry_events order by id");
  assert.equal(r.rows.length, 32);
  assert.deepEqual(
    r.rows.map((r) => r.id),
    Array.from({ length: 32 }, (_, i) => String(i + 1)),
  );
  assert.equal(r.rows.filter((r) => r.is_active).length, 8);
  assert.ok(
    r.rows.every((r) => r.status === "preview" && r.venue === "保留场所"),
  );
  assert.ok(r.rows.every((r) => r.cover === null && r.source_url === null));
  const a = await db.query("select * from furry_private.legacy_archive");
  assert.equal(a.rows.length, 32);
  assert.match(a.rows[0].row_data.cover, /furryfusion/);
});
test("distinct UUID same name same date, rename and reschedule preserve identity", async () => {
  const a = event(1, { name: "同名" }), b = event(2, { name: "同名" });
  assert.equal((await sync(db, [a, b])).upserted, 2);
  const rows = await db.query(
    "select * from furry_private.fcc_identity order by fcc_id",
  );
  const ids = rows.rows.map((r) => r.event_id);
  await sync(db, [
    event(1, {
      name: "新名",
      startDate: "2026-12-01T00:00:00Z",
      endDate: "2026-12-02T00:00:00Z",
    }),
    b,
  ], 2);
  assert.deepEqual(
    (await db.query(
      "select event_id from furry_private.fcc_identity order by fcc_id",
    )).rows.map((r) => r.event_id),
    ids,
  );
});
test("missing or empty FCC inventory never deactivates history or known FCC rows", async () => {
  await sync(db, [event(1), event(2)]);
  await sync(db, [event(1)], 2);
  await sync(db, [], 3);
  assert.equal(
    (await db.query("select count(*) from public.furry_events where is_active"))
      .rows[0].count,
    "10",
  );
  assert.equal(
    (await db.query(
      "select count(*) from public.furry_events where not is_active",
    )).rows[0].count,
    "24",
  );
});
test("reviewed legacy UUID mapping ignores duplicate source_id; preserves inactive state and enrichment", async () => {
  await db.query(
    "insert into furry_private.fcc_identity(fcc_id,event_id,mapping_kind) values($1,9,'reviewed_legacy')",
    [id(1)],
  );
  await sync(db, [event(1, { detail: null, place: {}, organization: {} })]);
  const r =
    (await db.query("select * from public.furry_events where id=9")).rows[0];
  assert.equal(r.is_active, false);
  assert.equal(r.source_id, "duplicate_legacy_id");
  assert.equal(r.status, "preview");
  assert.equal(r.detail, "保留详情");
  assert.equal(r.venue, "保留场所");
});
test("unreviewed matching historical key blocks entire snapshot", async () => {
  await assert.rejects(
    sync(db, [event(1, { name: "历史1", startDate: "2026-10-31T16:00:00Z" })]),
    /HISTORY_MAPPING_REQUIRED/,
  );
  assert.equal(
    (await db.query("select count(*) from public.furry_events")).rows[0].count,
    "32",
  );
});
test("null dates cancellation postponement and unknown statuses persist without invention", async () => {
  await sync(db, [
    event(1, { startDate: null, endDate: null, status: "cancelled" }),
    event(2, { status: "postponed" }),
    event(3, { status: "futureState" }),
  ]);
  const r = (await db.query(
    "select * from public.furry_events where source='fcc' order by id",
  )).rows;
  assert.equal(r[0].start_at, null);
  assert.equal(r[0].date_pending, true);
  assert.equal(r[0].native_status, "cancelled");
  assert.equal(r[1].native_status, "postponed");
  assert.equal(r[2].status_known, false);
});
test("failure in later record rolls back earlier insert, mapping and watermark", async () => {
  await assert.rejects(
    sync(db, [event(1), { ...event(2), cover: "https://evil.example/x" }]),
    /UNSAFE_PUBLIC_URL/,
  );
  assert.equal(
    (await db.query(
      "select count(*) from public.furry_events where source='fcc'",
    )).rows[0].count,
    "0",
  );
  assert.equal(
    (await db.query("select count(*) from furry_private.fcc_identity")).rows[0]
      .count,
    "0",
  );
  assert.equal(
    (await db.query("select last_started_at from furry_private.sync_state"))
      .rows[0].last_started_at,
    null,
  );
});
test("stale/replayed snapshot and incomplete flag cannot overwrite", async () => {
  await sync(db, [event(1)], 3);
  await assert.rejects(
    sync(db, [event(1, { name: "old" })], 2),
    /STALE_SNAPSHOT/,
  );
  await assert.rejects(sync(db, [event(1)], 3), /STALE_SNAPSHOT/);
  await assert.rejects(
    db.query("select public.sync_fcc_events($1,$2,$2,false)", [
      JSON.stringify([event(1)]),
      start(4),
    ]),
    /INCOMPLETE_SNAPSHOT/,
  );
});
test("concurrent snapshots serialize; older waiting snapshot rejected after newer commit", async () => {
  const a = connect(), b = connect();
  await a.connect();
  await b.connect();
  try {
    await a.query("begin");
    await sync(a, [event(1, { name: "new" })], 5);
    let settled = false;
    const waiting = sync(b, [event(1, { name: "old" })], 4).then(() => {
      settled = true;
      return null;
    }, (e) => {
      settled = true;
      return e;
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(settled, false);
    await a.query("commit");
    assert.match(String(await waiting), /STALE_SNAPSHOT/);
    assert.equal(
      (await db.query(
        "select name from public.furry_events where source='fcc'",
      )).rows[0].name,
      "new",
    );
  } finally {
    await a.end();
    await b.end();
  }
});
test("RLS and RPC permissions unchanged for clients; private metadata denied; old writer fenced", async () => {
  assert.equal(
    (await db.query(
      "select relrowsecurity from pg_class where oid='public.furry_events'::regclass",
    )).rows[0].relrowsecurity,
    true,
  );
  assert.equal(
    (await db.query(
      "select has_function_privilege('anon','public.sync_fcc_events(jsonb,timestamptz,timestamptz,boolean)','execute') allowed",
    )).rows[0].allowed,
    false,
  );
  assert.equal(
    (await db.query(
      "select has_schema_privilege('anon','furry_private','usage') allowed",
    )).rows[0].allowed,
    false,
  );
  await db.query("set role service_role");
  try {
    await assert.rejects(
      db.query("select public.sync_furry_events('[]',now(),false)"),
      /permission denied/,
    );
    await sync(db, [event(1)]);
  } finally {
    await db.query("reset role");
  }
});
test(
  "optional real private backup restores and migrates all original IDs and activation states",
  { skip: !process.env.FCC_BACKUP_PATH },
  async () => {
    const b = JSON.parse(await readFile(process.env.FCC_BACKUP_PATH!, "utf8"));
    await db.query(
      "drop schema furry_private cascade; drop schema public cascade; create schema public;",
    );
    await db.query(shape.replace(/CREATE ROLE [^;]+;/g, ""));
    for (const r of b.rows) {
      const keys = Object.keys(r);
      await db.query(
        `insert into public.furry_events(${
          keys.map((k) => '"' + k + '"').join(",")
        }) values(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
        keys.map((k) => r[k]),
      );
    }
    await db.query("select setval('public.furry_events_id_seq',$1,$2)", [
      b.sequence.last_value,
      b.sequence.is_called,
    ]);
    await db.query(migration);
    const rows = (await db.query(
      "select id,is_active,status from public.furry_events order by id",
    )).rows;
    assert.equal(rows.length, 32);
    assert.deepEqual(
      rows,
      b.rows.map((r: Record<string, unknown>) => ({
        id: String(r.id),
        is_active: r.is_active,
        status: r.status,
      })),
    );
  },
);
test("reviewed distinct decision permits genuinely separate event on a legacy name/day", async () => {
  await db.query(
    "insert into furry_private.fcc_distinct_decisions values($1,$2)",
    [id(1), "Reviewed organization and venue prove this is a distinct event."],
  );
  await sync(db, [
    event(1, { name: "历史1", startDate: "2026-10-31T16:00:00Z" }),
  ]);
  assert.equal(
    (await db.query(
      "select count(*) from public.furry_events where name='历史1'",
    )).rows[0].count,
    "2",
  );
});
test("DB independently rejects impossible date and duplicate UUID with rollback", async () => {
  await assert.rejects(
    sync(db, [{
      ...event(1),
      start_at: "2026-02-30T00:00:00+08:00",
      end_at: null,
    }]),
  );
  await assert.rejects(sync(db, [event(1), event(1)]), /DUPLICATE_FCC_ID/);
  assert.equal(
    (await db.query("select count(*) from public.furry_events")).rows[0].count,
    "32",
  );
});

test("full mocked FCC API -> handler -> PostgreSQL -> query -> legacy aliases", async () => {
  const { createSyncHandler, createSearchHandler } = await import(
    "../../supabase/functions/_shared/handlers.ts"
  );
  const { api } = await import("../fixtures.ts");
  const handler = createSyncHandler({
    secret: () => "local",
    token: () => "fixture-token",
    now: () => new Date(start(1)),
    fetchImpl: api([
      raw(1, { startDate: null, endDate: null, status: "movedOnline" }),
    ]),
    sync: async (s) =>
      (await db.query("select public.sync_fcc_events($1,$2,$3,$4) result", [
        JSON.stringify(s.events),
        s.started_at,
        s.completed_at,
        s.complete,
      ])).rows[0].result,
  });
  const result = await handler(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer test", "x-function-secret": "local" },
    }),
  );
  assert.equal(result.status, 200);
  assert.equal((await result.json()).deactivated, 0);
  const search = createSearchHandler({
    imageEndpoint: "https://local/functions/v1/furry-event-image",
    readRows: async () =>
      (await db.query("select * from public.furry_events")).rows,
    now: () => new Date(start(1)),
  });
  const response = await search(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer test" },
      body: "{}",
    }),
  );
  const payload = await response.json();
  const e = payload.events.find((e: Record<string, unknown>) =>
    e.native_status === "movedOnline"
  );
  assert.equal(e.start_at, null);
  assert.equal(e.startAt, "时间待定");
  assert.equal(e.raw_status, "线上举办");
  assert.doesNotMatch(
    JSON.stringify(payload),
    /https?:[^\s]*furryfusion[.]net/,
  );
});
