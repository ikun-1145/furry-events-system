// Synthetic local Postgres only: reproduction of production RPC type failures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
let server: EmbeddedPostgres, db: pg.Client, dir: string;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fcc-legacy-rpc-"));
  server = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "local-test-only", port: 55449, persistent: false, onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  db = new pg.Client({ host: "127.0.0.1", port: 55449, user: "postgres", password: "local-test-only", database: "postgres" });
  await db.connect();
  await db.query(await readFile(new URL("./production-shape.sql", import.meta.url), "utf8"));
  await db.query("insert into public.furry_events(id,name,start_at,end_at,status,city) values (1,'synthetic','2027-01-01T00:00:00+08:00','2027-01-02T00:00:00+08:00','rescheduled','test')");
  // The captured production functions can exist with unchecked bodies.
  await db.query("set check_function_bodies=off");
  await db.query(`create function public.get_event_cities() returns table(city text,event_count bigint) language sql stable as $$ select city,count(*) from public.furry_events where start_at >= now() and city is not null and status != 'cancelled' group by city order by count(*) desc,city asc $$`);
  await db.query(`create function public.get_rescheduled_events(p_limit integer default 20) returns table(id uuid,name text,event_date text,city text,venue text,cover text,status text,start_at timestamptz) language sql stable as $$ select fe.id,fe.name,to_char(fe.start_at at time zone 'Asia/Shanghai','YYYY-MM-DD'),fe.city,fe.venue,fe.cover,fe.status,fe.start_at from public.furry_events fe where fe.status='rescheduled' and fe.start_at>=now() order by fe.start_at asc limit p_limit $$`);
  await db.query(`create function public.get_upcoming_events(p_city text default null,p_status text default null,p_limit integer default 50) returns table(id uuid,name text,event_date text,event_time text,city text,venue text,address text,cover text,status text,source_url text,start_at timestamptz,end_at timestamptz) language sql stable as $$ select fe.id,fe.name,to_char(fe.start_at at time zone 'Asia/Shanghai','YYYY-MM-DD'),to_char(fe.start_at at time zone 'Asia/Shanghai','HH24:MI'),fe.city,fe.venue,fe.address,fe.cover,fe.status,fe.source_url,fe.start_at,fe.end_at from public.furry_events fe where fe.start_at>=now() and (p_city is null or fe.city=p_city) and (p_status='all' or (p_status is null and fe.status!='cancelled') or (p_status is not null and p_status!='all' and fe.status=p_status)) order by fe.start_at asc limit p_limit $$`);
  await db.query("set check_function_bodies=on");
});
after(async () => { await db?.end(); await server?.stop(); if (dir) await rm(dir, { recursive: true, force: true }); });
for (const [name, expected] of [["get_event_cities", /operator does not exist: text >= timestamp with time zone/], ["get_rescheduled_events", /function pg_catalog.timezone\(unknown, text\) does not exist/], ["get_upcoming_events", /function pg_catalog.timezone\(unknown, text\) does not exist/]] as const) {
  test(`captured ${name} fails against current bigint/text table shape`, async () => {
    await assert.rejects(db.query(`select * from public.${name}()`), (e: any) => e.code === "42883" && expected.test(e.message));
  });
}
test("legacy UUID return contract cannot return bigint ID even with date issue removed", async () => {
  await db.query("set check_function_bodies=off");
  await db.query("create function public.synthetic_uuid_result() returns table(id uuid) language sql as $$ select id from public.furry_events $$");
  await db.query("set check_function_bodies=on");
  await assert.rejects(db.query("select * from public.synthetic_uuid_result()"), (e: any) => e.code === "42P13");
});
