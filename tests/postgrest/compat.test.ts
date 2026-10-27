/** Isolated containers only. No production URLs, credentials, backups or Docker host networking. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { readFilteredRows } from "../../supabase/functions/_shared/query_repository.ts";
const env = { ...process.env };
for (
  const k of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]
) delete env[k];
function docker(args: string[], input?: string) {
  const r = spawnSync(
    "docker",
    ["--host=unix:///var/run/docker.sock", ...args],
    { env, input, encoding: "utf8" },
  );
  if (r.status !== 0) throw Error("Local Docker operation failed: " + args[0]);
  return r.stdout.trim();
}
const sleep = () => new Promise((r) => setTimeout(r, 250));
test("real PostgREST 13 + PostgreSQL 17: service-only filtered RPC, bigint >2^53, 1500 rows, no truncation", async () => {
  const suffix = String(process.pid),
    net = "fcc-rest-" + suffix,
    db = "fcc-pg-" + suffix,
    rest = "fcc-api-" + suffix;
  try {
    docker(["network", "create", "--internal", net]);
    docker([
      "run",
      "-d",
      "--name",
      db,
      "--network",
      net,
      "-e",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:17",
    ]);
    let ready = false;
    for (let i = 0; i < 80; i++) {
      const r = spawnSync("docker", [
        "--host=unix:///var/run/docker.sock",
        "exec",
        db,
        "pg_isready",
        "-U",
        "postgres",
      ], { env, encoding: "utf8" });
      if (r.status === 0) {
        ready = true;
        break;
      }
      await sleep();
    }
    assert.equal(ready, true);
    const shape = await readFile("tests/db/production-shape.sql", "utf8"),
      migration = await readFile(
        "supabase/migrations/20261027061449_fcc_safe_ingestion.sql",
        "utf8",
      );
    docker(
      ["exec", "-i", db, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
      shape + "\n" + migration +
        "\ninsert into public.furry_events(id,name,source,city,start_at,is_active) select 9007199254740992+n,'event'||n,'fcc','北京,%',null,true from generate_series(1,1500)n;",
    );
    const secret = "isolated-postgrest-test-secret-not-a-production-credential";
    docker([
      "run",
      "-d",
      "--name",
      rest,
      "--network",
      net,
      "-p",
      "127.0.0.1:55442:3000",
      "-e",
      `PGRST_DB_URI=postgresql://postgres@${db}:5432/postgres`,
      "-e",
      "PGRST_DB_SCHEMAS=public",
      "-e",
      "PGRST_DB_ANON_ROLE=anon",
      "-e",
      `PGRST_JWT_SECRET=${secret}`,
      "postgrest/postgrest:v13.0.8",
    ]);
    const url = "http://" + rest + ":3000";
    // Run HTTP inside the isolated Docker network; no host-network bypass or production egress.
    const http: typeof fetch = async (input, init) => {
      const worker =
        `let text='';for await(const c of process.stdin)text+=c;const p=JSON.parse(text);const r=await fetch(p.url,p.init);console.log(JSON.stringify({status:r.status,headers:[...r.headers],body:await r.text()}));`;
      const request = {
        url: String(input).replace("/rest/v1/", "/"),
        init: {
          ...init,
          headers: [...new Headers(init?.headers)],
          signal: undefined,
        },
      };
      const result = docker([
        "run",
        "--rm",
        "-i",
        "--network",
        net,
        "node:24-bookworm-slim",
        "node",
        "-e",
        worker,
      ], JSON.stringify(request));
      const r = JSON.parse(result);
      return new Response(r.body, { status: r.status, headers: r.headers });
    };
    ready = false;
    for (let i = 0; i < 5; i++) {
      try {
        if ((await http(url)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep();
    }
    assert.equal(ready, true);
    const encoded = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = encoded({ alg: "HS256", typ: "JWT" }) + "." +
      encoded({
        role: "service_role",
        exp: Math.floor(Date.now() / 1000) + 300,
      });
    const jwt = body + "." +
      createHmac("sha256", secret).update(body).digest("base64url");
    const direct = createClient(url, "local-fixture-key", {
      global: { headers: { Authorization: `Bearer ${jwt}` }, fetch: http },
      auth: { persistSession: false },
    });
    let calls = 0;
    const rows = await readFilteredRows(
      async (a) => {
        calls++;
        const { data, error } = await direct.rpc("read_fcc_event_page", a);
        assert.equal(error, null);
        return data;
      },
      { city: "北京,%" },
      new Date("2026-10-27"),
    );
    assert.equal(rows.length, 1500);
    assert.equal(rows[0].id, "9007199254740993");
    assert.equal(calls, 4);
    const denied = await http(url + "/rpc/read_fcc_event_page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_criteria: {}, p_after_id: "0", p_limit: 500 }),
    });
    assert.ok([401, 403, 404].includes(denied.status));
    const { error } = await direct.rpc("read_fcc_event_page", {
      p_criteria: {},
      p_after_id: "0",
      p_limit: 501,
    });
    assert.notEqual(error, null);
  } finally {
    for (const name of [rest, db]) {
      spawnSync("docker", [
        "--host=unix:///var/run/docker.sock",
        "rm",
        "-f",
        name,
      ], { env, encoding: "utf8" });
    }
    spawnSync("docker", [
      "--host=unix:///var/run/docker.sock",
      "network",
      "rm",
      net,
    ], { env, encoding: "utf8" });
  }
});
