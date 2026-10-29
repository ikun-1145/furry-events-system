import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchFccSnapshot,
  normalizeFccEvent,
} from "../supabase/functions/_shared/fcc_adapter.ts";
import { createSyncHandler } from "../supabase/functions/_shared/handlers.ts";
import { api, raw } from "./fixtures.ts";
const get = (f: typeof fetch) =>
  fetchFccSnapshot("fixture-token", { fetchImpl: f, pageSize: 2 });
test("normal multi-page snapshot: authenticated, two consistent passes, no old hosts", async () => {
  const calls: string[] = [];
  const f: typeof fetch = async (u, i) => {
    calls.push(String(u));
    assert.equal(
      new Headers(i?.headers).get("Authorization"),
      "Bearer fixture-token",
    );
    assert.equal(i?.redirect, "error");
    assert.equal(new URL(String(u)).hostname, "api.furrycons.cn");
    return api([raw(1), raw(2), raw(3)], 2)(u, i);
  };
  const r = await get(f);
  assert.equal(r.events.length, 3);
  assert.equal(r.pages, 2);
  assert.equal(calls.length, 4);
});
test("failed second page rejects snapshot", async () => {
  await assert.rejects(
    get(async (u, i) =>
      new URL(String(u)).searchParams.get("current") === "2"
        ? new Response("", { status: 500 })
        : api([raw(1), raw(2), raw(3)], 2)(u, i)
    ),
    /FCC_HTTP_ERROR/,
  );
});
test("HTTP 200 business error is never an empty success", async () => {
  await assert.rejects(
    get(async () =>
      Response.json({
        total: 0,
        current: 1,
        pageSize: 2,
        data: [],
        info: "No event available",
      })
    ),
    /FCC_BUSINESS_ERROR/,
  );
});
test("valid empty list remains explicit complete empty", async () =>
  assert.equal((await get(api([], 2))).events.length, 0));
for (
  const [status, code] of [[401, "FCC_AUTH_FAILED"], [403, "FCC_AUTH_FAILED"], [
    429,
    "FCC_RATE_LIMITED",
  ]] as const
) {
  test(`HTTP ${status} does not leak token or response`, async () => {
    await assert.rejects(
      get(async () =>
        new Response("sensitive body fixture-token", {
          status,
          headers: { "Retry-After": "5" },
        })
      ),
      new RegExp(code),
    );
  });
}
test("missing token performs no request", async () =>
  assert.rejects(
    fetchFccSnapshot("", {
      fetchImpl: async () => {
        throw Error("must not fetch");
      },
    }),
    /FCC_TOKEN_NOT_CONFIGURED/,
  ));
test("page total drift, duplicate UUID, short page and changed data all reject", async () => {
  for (const mode of ["total", "duplicate", "short", "change"]) {
    let count = 0;
    await assert.rejects(get(async (u, i) => {
      count++;
      const r = await api([raw(1), raw(2), raw(3)], 2)(u, i);
      const p = await r.json();
      if (mode === "total" && count === 2) p.total = 4;
      if (mode === "duplicate" && count === 2) p.data = [raw(1)];
      if (mode === "short" && count === 1) p.data.pop();
      if (mode === "change" && count === 3) p.data[0].name = "变更";
      return Response.json(p);
    }));
  }
});
test("same name and day distinct UUIDs remain distinct", async () => {
  const r = await get(
    api([raw(1, { name: "同名" }), raw(2, { name: "同名" })], 2),
  );
  assert.equal(r.events.length, 2);
});
test("null dates and every native state are retained; unknown is explicit", () => {
  for (
    const status of [
      "cancelled",
      "postponed",
      "rescheduled",
      "movedOnline",
      "scheduled",
      "futureState",
    ]
  ) {
    const r = normalizeFccEvent(
      raw(1, { startDate: null, endDate: null, status }),
    );
    assert.equal(r.start_at, null);
    assert.equal(r.native_status, status);
    assert.equal(r.status_known, status !== "futureState");
  }
});
test("invalid UUID, name, impossible date, reversed range and region reject", () => {
  for (
    const change of [
      { id: "no" },
      { name: "" },
      { startDate: "2026-02-30T00:00:00Z" },
      { endDate: "2020-01-01T00:00:00Z" },
      { region: {} },
    ]
  ) assert.throws(() => normalizeFccEvent(raw(1, change)));
});
test("documented null relations retain events without fabricated relation data", () => {
  for (const changes of [{ place: null }, { organization: null }, {
    place: null, organization: null,
  }]) {
    const e = normalizeFccEvent(raw(1, changes));
    assert.equal(e.fcc_id, raw(1).id);
    assert.equal(e.venue, changes.place === null ? null : "会场");
    assert.equal(e.organization, changes.organization === null ? null : "组织");
    assert.equal(e.address, "会展中心");
  }
});
test("required relation keys reject missing, array and scalar values", () => {
  for (const key of ["place", "organization"]) {
    const missing: Record<string, unknown> = raw(1);
    delete missing[key];
    for (const event of [missing, ...[undefined, [], "venue", 1, true].map(
      (value) => raw(1, { [key]: value }),
    )]) {
      assert.throws(() => normalizeFccEvent(event), /FCC_INVALID_RELATION/);
    }
  }
});
test("null relation support does not weaken nested field validation", () => {
  for (const changes of [
    { place: { name: 1 } },
    { place: { address: [] } },
    { organization: { name: false } },
    { place: null, organization: { name: 1 } },
    { organization: null, place: { name: [] } },
  ]) assert.throws(() => normalizeFccEvent(raw(1, changes)), /FCC_INVALID_/);
});
test("two-pass synthetic snapshot retains a real-shape null-place event", async () => {
  const r = await get(api([raw(1, { place: null }), raw(2)], 2));
  assert.equal(r.events.length, 2);
  assert.equal(r.events.find((e) => e.fcc_id === raw(1).id)?.venue, null);
});
test("untrusted/retired URLs become null", () => {
  const e = normalizeFccEvent(
    raw(1, {
      thumbnail: "https://image.furryfusion.net/x",
      url: "https://www.furryfusion.net/x",
    }),
  );
  assert.equal(e.cover, null);
  assert.equal(e.source_url, null);
});
test("detail preserves valid FCC strings, null, whitespace and control characters", () => {
  for (const value of [null, "", " \n\t\r ", "a\u0003b\n😀", "x".repeat(20001), "https://furryfusion.net/example"]) {
    assert.equal(normalizeFccEvent(raw(1, { detail: value })).detail, value);
  }
  for (const value of [undefined, 1, false, [], {}]) {
    assert.throws(() => normalizeFccEvent(raw(1, { detail: value })), /FCC_INVALID_DETAIL/);
  }
  const missing: Record<string, unknown> = raw(1);
  delete missing.detail;
  assert.throws(() => normalizeFccEvent(missing), /FCC_INVALID_DETAIL/);
});
test("all upstream failures leave DB untouched; empty snapshot also does not call RPC", async () => {
  for (
    const f of [
      async () => new Response("", { status: 401 }),
      async () => Response.json({ info: "fail" }),
      api([], 20),
    ]
  ) {
    let writes = 0;
    const h = createSyncHandler({
      secret: () => "secret",
      token: () => "fixture-token",
      fetchImpl: f,
      sync: async () => {
        writes++;
        return {};
      },
    });
    await h(
      new Request("https://local", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "x-function-secret": "secret",
        },
      }),
    );
    assert.equal(writes, 0);
  }
});
test("a valid empty FCC inventory fails explicitly and never invokes the database", async () => {
  let writes = 0;
  const h = createSyncHandler({
    secret: () => "secret",
    token: () => "fixture-token",
    fetchImpl: api([], 20),
    sync: async () => { writes++; return {}; },
  });
  const response = await h(new Request("https://local", {
    method: "POST", headers: { Authorization: "Bearer test", "x-function-secret": "secret" },
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { success: false, error: "FCC_EMPTY_SNAPSHOT" });
  assert.equal(writes, 0);
});
test("complete snapshot accepts a nonnegative FCC-only deactivation receipt", async () => {
  for (const count of [0, 2, -1, 1.5, null]) {
    const h = createSyncHandler({
      secret: () => "secret", token: () => "fixture-token",
      fetchImpl: api([raw(1)], 20),
      sync: async () => ({upserted: 1, deactivated: count}),
    });
    const response = await h(new Request("https://local", {
      method: "POST", headers: {Authorization: "Bearer test", "x-function-secret": "secret"},
    }));
    assert.equal(response.status, count === 0 || count === 2 ? 200 : 500);
  }
});
test("sync preserves entry auth and forbids any empty override", async () => {
  let writes = 0;
  const h = createSyncHandler({
    secret: () => "secret",
    token: () => "",
    sync: async () => {
      writes++;
    },
  });
  assert.equal(
    (await h(new Request("https://local", { method: "GET" }))).status,
    405,
  );
  assert.equal(
    (await h(new Request("https://local", { method: "POST" }))).status,
    401,
  );
  assert.equal(
    (await h(
      new Request("https://local", {
        method: "POST",
        headers: { Authorization: "Bearer x" },
      }),
    )).status,
    403,
  );
  assert.equal(
    (await h(
      new Request("https://local", {
        method: "POST",
        headers: { Authorization: "Bearer x", "x-function-secret": "secret" },
        body: '{"allow_empty":true}',
      }),
    )).status,
    403,
  );
  assert.equal(writes, 0);
});
test("error response never echoes upstream or token", async () => {
  const h = createSyncHandler({
    secret: () => "secret",
    token: () => "fixture-token",
    fetchImpl: async () => {
      throw Error("fixture-token");
    },
    sync: async () => {
      throw Error("no");
    },
  });
  const r = await h(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer x", "x-function-secret": "secret" },
    }),
  );
  assert.doesNotMatch(await r.text(), /fixture-token/);
});

test("HTTP 200 explicit success=false or error flag rejects otherwise valid inventory", async () => {
  for (const flags of [{ success: false }, { error: "failure" }]) {
    await assert.rejects(
      get(async () =>
        Response.json({ total: 0, current: 1, pageSize: 2, data: [], ...flags })
      ),
      /FCC_BUSINESS_ERROR/,
    );
  }
});

test('NUL in an otherwise valid FCC snapshot is rejected before database writes', async () => {
  let writes = 0;
  const h = createSyncHandler({
    secret: () => 'secret', token: () => 'fixture-token',
    fetchImpl: api([raw(1, { detail: 'before\0after' })], 20),
    sync: async () => { writes++; return { upserted: 1, deactivated: 0 }; },
  });
  const r = await h(new Request('https://local', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'x-function-secret': 'secret' },
  }));
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, 'FCC_POSTGRES_NUL');
  assert.equal(writes, 0);
});
