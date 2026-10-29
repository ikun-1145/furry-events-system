import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { classify, mappingSql } from "../scripts/mapping-risk.ts";
import {
  fetchFccSnapshot,
  normalizeFccEvent,
} from "../supabase/functions/_shared/fcc_adapter.ts";
import { api, id, raw } from "./fixtures.ts";
import {
  criteria,
  readFilteredRows,
} from "../supabase/functions/_shared/query_repository.ts";
import { publicEvent } from "../supabase/functions/_shared/public_events.ts";
const event = () => normalizeFccEvent(raw(1));
const old = [{
  id: 9,
  name: "历史聚会",
  start_at: "2026-11-01",
  city: "北京",
  organization: "历史主办",
}];
test("risk classification: new, changed date/name traces, unknown identity and source_id collision", () => {
  assert.equal(classify([event()], old)[0].risk, "new");
  for (
    const e of [
      { ...event(), name: "历史聚会", start_at: "2028-01-01" },
      { ...event(), name: "历史聚会·夏季" },
      { ...event(), organization: "历史主办" },
      { ...event(), city: null },
    ]
  ) assert.equal(classify([e], old)[0].risk, "needs_review");
  assert.equal(
    classify([{ ...event(), source_id: "dup" }], [{
      ...old[0],
      source_id: "dup",
    }])[0].risk,
    "new",
  );
});
test("bound UUID cannot be rebound; inputs and duplicate identity rejected", () => {
  const p = classify([event()], old, [{ fcc_id: id(1), event_id: "9" }]);
  assert.equal(p[0].risk, "bound");
  assert.throws(
    () => mappingSql([{ ...p[0], decision: "link", event_id: "10" }]),
    /REBIND/,
  );
  assert.throws(() => classify([event(), event()], old));
  assert.throws(() => classify([{ fcc_id: "invalid" }], old));
  assert.throws(() =>
    classify([event()], old, [{ fcc_id: id(1), event_id: 9 }, {
      fcc_id: id(2),
      event_id: 9,
    }])
  );
});
test("new classifications need no SQL decisions; review plans cannot silently skip", () => {
  assert.doesNotMatch(mappingSql(classify([event()], old)), /insert into/);
  const p = classify([{ ...event(), name: "历史聚会" }], old);
  assert.throws(() => mappingSql(p), /REVIEW_REQUIRED/);
  assert.throws(() =>
    mappingSql([{ ...p[0], decision: "link", event_id: "9" }, {
      ...p[0],
      fcc_id: id(2),
      decision: "link",
      event_id: "9",
    }])
  );
});
test("pagination limits and total deadline reject entire FCC snapshot", async () => {
  await assert.rejects(
    fetchFccSnapshot("fixture", {
      fetchImpl: api([raw(1), raw(2)], 1),
      pageSize: 1,
      maxPages: 1,
    }),
    /FCC_PAGE_LIMIT/,
  );
  await assert.rejects(
    fetchFccSnapshot("fixture", {
      fetchImpl: async (u, i) => {
        await new Promise((r) => setTimeout(r, 15));
        return api([raw(1)])(u, i);
      },
      totalTimeoutMs: 1,
    }),
    /FCC_TOTAL_TIMEOUT/,
  );
});
test("DB pagination reads >1000, exact 500 boundary, uses exact bigint strings, fails closed", async () => {
  const rows = Array.from(
    { length: 1500 },
    (_, i) => ({ id: String(9007199254740993n + BigInt(i)) }),
  );
  let calls = 0;
  const result = await readFilteredRows(
    async (a) => {
      calls++;
      return rows.filter((r) => BigInt(r.id) > BigInt(a.p_after_id)).slice(
        0,
        a.p_limit,
      );
    },
    {},
    new Date(),
  );
  assert.equal(result.length, 1500);
  assert.equal(calls, 4);
  assert.equal(result[0].id, "9007199254740993");
  await assert.rejects(
    readFilteredRows(
      async () => {
        throw Error("DB unavailable");
      },
      {},
      new Date(),
    ),
    /DB unavailable/,
  );
  await assert.rejects(
    readFilteredRows(async () => [{ id: 9007199254740992 }], {}, new Date()),
    /INVALID_DATABASE_ID/,
  );
});
test("criteria preserve pending dates include_inactive and literal city punctuation", () => {
  const now = new Date("2026-10-27T00:00:00Z");
  assert.deepEqual(
    criteria({ month: 1, city: " 北京,% ", include_inactive: true }, now),
    {
      include_inactive: true,
      city: "北京,%",
      start: "2027-01-01",
      end: "2027-02-01",
      include_undated: false,
    },
  );
  assert.equal(criteria({}, now).include_undated, true);
});
test("public legacy record explicitly has no detail link and stable owned placeholder", () => {
  const r = publicEvent({
    id: 9,
    cover: "https://image.furryfusion.net/x",
    source_url: "https://www.furryfusion.net/x",
  }, "https://own.example/image");
  assert.equal(r.detail_available, false);
  assert.equal(r.detail_link_text, "暂无详情链接");
  assert.equal(r.sourceUrl, null);
  assert.equal(r.coverUrl, "https://own.example/image");
});
test("workflow YAML fail-closed gate shared by manual and cron, concurrency queue and no retries", async () => {
  const y = YAML.parse(
    await readFile(".github/workflows/fetch-furry-events.yml", "utf8"),
  );
  assert.equal(y.on.schedule[0].cron, "0 2 */2 * *");
  assert.match(
    y.jobs["trigger-edge-function"].if,
    /vars.FCC_SYNC_ENABLED == 'true'/,
  );
  assert.equal(y.concurrency["cancel-in-progress"], false);
  const sh = await readFile("scripts/trigger-sync.sh", "utf8");
  assert.match(sh, /exec python3 scripts\/fcc-manual-trigger\.py/);
  assert.doesNotMatch(sh, /--header|curl --/);
});
test("frozen scheduled and manual runs never access network even with secrets configured", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const r = spawnSync("bash", ["scripts/trigger-sync.sh"], {
      env: {
        PATH: "/usr/bin:/bin",
        FCC_SYNC_ENABLED: "false",
        GITHUB_EVENT_NAME: event,
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /frozen/);
  }
});
test("unfrozen workflow invokes the bounded trigger once without secrets in arguments", async () => {
  const d = await mkdtemp(path.join(tmpdir(), "fcc-trigger-"));
  try {
    await writeFile(
      path.join(d, "python3"),
      '#!/bin/bash\nprintf "%s" "$*" > "$CALLS_FILE"\nexit "${MOCK_EXIT:-0}"\n',
      { mode: 0o700 },
    );
    const r = spawnSync("bash", ["scripts/trigger-sync.sh"], {
      env: {
        ...process.env,
        PATH: d + ":" + process.env.PATH,
        FCC_SYNC_ENABLED: "true",
        GITHUB_REF: "refs/heads/main",
        SUPABASE_FUNCTION_URL:
          "https://klyrasrqgxijwrxuoevj.supabase.co/functions/v1/fetch-furry-events",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-sensitive",
        FUNCTION_SECRET: "fixture-sensitive",
        CALLS_FILE: path.join(d, "calls"),
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /fixture-sensitive/);
    assert.equal(await readFile(path.join(d, "calls"), "utf8"), "scripts/fcc-manual-trigger.py");
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test("later database page failure returns no partial query response; invalid query never reads DB", async () => {
  const { createSearchHandler } = await import(
    "../supabase/functions/_shared/handlers.ts"
  );
  let calls = 0;
  const h = createSearchHandler({
    imageEndpoint: "https://owned.invalid/image",
    readRows: async (p, n) =>
      readFilteredRows(
        async () => {
          calls++;
          if (calls === 2) throw Error("later page failed");
          return Array.from({ length: 500 }, (_, i) => ({ id: String(i + 1) }));
        },
        p,
        n,
      ),
  });
  const r = await h(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer fixture" },
      body: "{}",
    }),
  );
  assert.equal(r.status, 500);
  assert.equal((await r.json()).events, undefined);
  calls = 0;
  const bad = await h(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer fixture" },
      body: '{"month":99}',
    }),
  );
  assert.equal(bad.status, 400);
  assert.equal(calls, 0);
});
test("manual trigger from an unapproved ref remains frozen even when enabled", () => {
  const r = spawnSync("bash", ["scripts/trigger-sync.sh"], {
    env: {
      PATH: "/usr/bin:/bin",
      FCC_SYNC_ENABLED: "true",
      GITHUB_REF: "refs/heads/old",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /frozen/);
});

test("mapping SQL rejects dollar-quote delimiter injection in review reasons", () => {
  assert.throws(
    () =>
      mappingSql([{
        fcc_id: id(1),
        decision: "distinct",
        reason: "Reviewed but $$ delimiter cannot be interpolated safely",
      }]),
    /REVIEW_REASON_REQUIRED/,
  );
});
