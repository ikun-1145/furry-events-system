import test from "node:test";
import assert from "node:assert/strict";
import { historicalCandidates, inspectFcc } from "../scripts/fcc-readonly.ts";
import { api, raw } from "./fixtures.ts";
const history = Array.from(
  { length: 32 },
  (_, i) => ({
    id: i + 1,
    name: `活动${i + 1}`,
    start_at: "2026-11-01T10:00:00+08:00",
    is_active: i < 8,
  }),
);
test("readonly: no token performs zero network calls and enumerates all eight active histories", async () => {
  let calls = 0;
  const r = await inspectFcc("", history, async () => {
    calls++;
    throw Error();
  });
  assert.equal(calls, 0);
  assert.equal(r.real_api_verified, false);
  assert.equal(
    r.history.filter((x: Record<string, unknown>) => x.is_active).length,
    8,
  );
  assert.equal(r.history[0].candidates, null);
});
test("readonly: complete two-pass inventory and bounded HEAD probes never access DB/old host or forward token", async () => {
  const methods: string[] = [];
  const r = await inspectFcc("mock-token", history, async (u, i) => {
    const url = new URL(String(u));
    methods.push(i?.method ?? "GET");
    if (url.hostname === "api.furrycons.cn") {
      assert.equal(
        new Headers(i?.headers).get("authorization"),
        "Bearer mock-token",
      );
      return api([raw(1)])(u, i);
    }
    assert.equal(i?.method, "HEAD");
    assert.equal(new Headers(i?.headers).has("authorization"), false);
    assert.ok(
      ["images.furrycons.cn", "www.furrycons.cn"].includes(url.hostname),
    );
    return new Response(null, {
      headers: {
        "content-type": url.hostname.startsWith("images")
          ? "image/jpeg"
          : "text/html",
      },
    });
  });
  assert.equal(r.real_api_verified, true);
  assert.equal(methods.filter((x) => x === "GET").length, 2);
  assert.equal(r.history[0].candidates[0].decision, null);
  assert.doesNotMatch(JSON.stringify(r), /mock-token/);
});
test("readonly: failed inventory never generates false unmatched decisions or resource requests", async () => {
  let count = 0;
  const r = await inspectFcc("mock-token", history, async () => {
    count++;
    return Response.json({ info: "failure" });
  });
  assert.equal(r.real_api_verified, false);
  assert.equal(count, 1);
  assert.equal(r.history[0].candidates, null);
});
test("readonly: same date alone is weak and duplicate legacy IDs are not identity evidence", () => {
  const r = historicalCandidates([{
    id: 1,
    name: "A",
    start_at: "2026-01-01",
    source_id: "dup",
  }], [{ fcc_id: "x", name: "B", start_at: "2026-01-01", source_id: "dup" }]);
  assert.equal(r[0].candidates![0].confidence, "weak_candidate");
});
