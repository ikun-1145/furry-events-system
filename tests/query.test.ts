import test from "node:test";
import assert from "node:assert/strict";
import {
  publicEvent,
  searchRows,
} from "../supabase/functions/_shared/public_events.ts";
import { createImageHandler } from "../supabase/functions/_shared/image_handler.ts";
import { createSearchHandler } from "../supabase/functions/_shared/handlers.ts";
import worker from "../workers/sunland-data-worker/src/index.ts";
const endpoint = "https://project.supabase.co/functions/v1/furry-event-image";
const row = {
  id: 1,
  name: "测试",
  source: "fcc",
  is_active: true,
  start_at: null,
  end_at: null,
  native_status: "postponed",
  cover: "https://image.furryfusion.net/a",
  source_url: "https://www.furryfusion.net/a",
  detail: "见 https://www.furryfusion.net/x",
};
test("legacy aliases preserve null truth with explicit pending display", () => {
  const e = publicEvent(row, endpoint);
  assert.equal(e.start_at, null);
  assert.equal(e.startAt, "时间待定");
  assert.equal(e.end_at, null);
  assert.equal(e.endAt, "时间待定");
  assert.equal(e.date_pending, true);
  assert.equal(e.native_status, "postponed");
  assert.equal(e.rawStatus, "已延期");
  assert.equal(e.raw_status, e.rawStatus);
  assert.equal(e.coverUrl, endpoint);
  assert.equal(e.cover, e.cover_url);
  assert.equal(e.sourceUrl, null);
  assert.doesNotMatch(JSON.stringify(e), /https?:[^\s]*furryfusion\.net/);
});
test("safe FCC image is served through bounded fallback handler", () => {
  assert.match(
    String(
      publicEvent({ ...row, cover: "https://images.furrycons.cn/x" }, endpoint)
        .cover,
    ),
    /furry-event-image\?url=/,
  );
});
test("search supports both sources, inactive boundary, pending dates and month filters", () => {
  const data = [row, {
    ...row,
    id: 2,
    source: "furfantasia_event_data",
    start_at: "2026-11-01T00:00:00+08:00",
  }, { ...row, id: 3, is_active: false }];
  const now = new Date("2026-10-27T00:00:00Z");
  assert.equal(searchRows(data, {}, now).length, 2);
  assert.equal(searchRows(data, { include_inactive: true }, now).length, 3);
  assert.equal(searchRows(data, { month: 11, year: 2026 }, now).length, 1);
  assert.throws(() => searchRows(data, { month: 13 }, now));
});
test("image outage/invalid content/redirect/empty/forbidden host yield owned SVG", async () => {
  for (
    const f of [
      async () => new Response("", { status: 404 }),
      async () =>
        new Response("html", { headers: { "content-type": "text/html" } }),
      async () => {
        throw Error("redirect");
      },
      async () =>
        new Response("", { headers: { "content-type": "image/jpeg" } }),
    ]
  ) {
    const r = await createImageHandler(f)(
      new Request(`${endpoint}?url=https://images.furrycons.cn/x`),
    );
    assert.equal(r.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.match(await r.text(), /活动图片暂不可用/);
  }
  let calls = 0;
  await createImageHandler(async () => {
    calls++;
    throw Error();
  })(new Request(`${endpoint}?url=https://image.furryfusion.net/x`));
  assert.equal(calls, 0);
});
test("valid FCC image, HEAD and public placeholder", async () => {
  const h = createImageHandler(async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
  );
  assert.equal(
    (await h(new Request(`${endpoint}?url=https://images.furrycons.cn/x`)))
      .headers.get("content-type"),
    "image/png",
  );
  assert.equal(
    await (await h(new Request(endpoint, { method: "HEAD" }))).text(),
    "",
  );
  assert.equal(
    (await h(new Request(endpoint, { method: "POST" }))).status,
    405,
  );
});
test("query auth preserved and internal fields never escape", async () => {
  const h = createSearchHandler({
    imageEndpoint: endpoint,
    readRows: async () => [{
      ...row,
      raw_json: { secret: "private" },
      row_data: { secret: "archive" },
    }],
  });
  assert.equal(
    (await h(new Request("https://local", { method: "POST" }))).status,
    401,
  );
  const r = await h(
    new Request("https://local", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: "{}",
    }),
  );
  assert.equal(r.status, 200);
  assert.doesNotMatch(await r.text(), /archive|private|raw_json/);
});
test("retained Worker service has no network path and retires old proxy", async () => {
  for (const path of ["/", "/proxy?url=https://image.furryfusion.net/x"]) {
    assert.equal(
      (await worker.fetch(new Request("https://worker" + path))).status,
      410,
    );
  }
  assert.equal(
    (await worker.fetch(new Request("https://worker/health"))).status,
    200,
  );
});
