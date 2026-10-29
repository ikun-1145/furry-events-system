import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  formatFurryEventDateRange,
  normalizeFurryEvents,
} from "./compat/web-furry-events.mjs";
import { appendFurryEventMessage } from "./compat/web-furry-event-cards.mjs";
import { publicEvent } from "../supabase/functions/_shared/public_events.ts";
const endpoint = "https://project.supabase.co/functions/v1/furry-event-image";
const row = {
  id: 1,
  name: "同名活动",
  start_at: null,
  end_at: null,
  city: "上海",
  native_status: "postponed",
};
test("real Web parser + DOM: pending dates/native status/owned fallback visibly render", () => {
  const dom = new JSDOM("<main></main>");
  const target = dom.window.document.querySelector("main");
  const e = publicEvent(row, endpoint);
  assert.equal(formatFurryEventDateRange(e), "时间待定");
  appendFurryEventMessage({
    target,
    message: { isFurryCard: true, furryEvents: [e] },
  });
  assert.match(target!.textContent!, /时间待定/);
  assert.match(target!.textContent!, /延期/);
  assert.equal(target!.querySelector("img")!.src, endpoint);
});
test("client identity patch retains two same-name same-day same-city events through normalization and rendering", () => {
  const events = [
    publicEvent({ ...row, start_at: "2026-11-01T00:00:00+08:00" }, endpoint),
    publicEvent(
      { ...row, id: 2, start_at: "2026-11-01T00:00:00+08:00" },
      endpoint,
    ),
  ];
  assert.equal(normalizeFurryEvents(events).length, 2);
  const dom = new JSDOM("<main></main>");
  const target = dom.window.document.querySelector("main");
  appendFurryEventMessage({ target, message: { furryEvents: events } });
  assert.equal(target!.querySelectorAll("article").length, 2);
});
test("FCC UUID is the identity; names, dates and legacy source IDs do not merge distinct events", () => {
  const base = { name: "同名活动", start_at: "2026-11-01", city: "上海" };
  const a = "fcc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const b = "fcc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal(normalizeFurryEvents([
    { ...base, id: "7", source_id: a },
    { ...base, id: "7", source_id: b },
    { ...base, id: "8", source_id: a.toUpperCase() },
  ]).length, 2);
  assert.equal(normalizeFurryEvents([
    { ...base, id: "9", source_id: "duplicate-legacy" },
    { ...base, id: "10", source_id: "duplicate-legacy" },
  ]).length, 2);
  assert.equal(normalizeFurryEvents([
    { ...base, source_id: "duplicate-legacy" },
    { ...base, source_id: "duplicate-legacy" },
    { ...base, source_id: "fcc:------------------------------------" },
    { ...base, source_id: "fcc:------------------------------------" },
  ]).length, 4);
  assert.equal(normalizeFurryEvents([base, base]).length, 2);
});
test("client patch suppresses persisted retired covers and links without requesting them", () => {
  const e = normalizeFurryEvents([{
    name: "旧卡片",
    start_at: "2026-11-01",
    cover: "https://image.furryfusion.net/x",
    source_url: "https://www.furryfusion.net/x",
  }])[0];
  assert.equal(e.cover, null);
  assert.equal(e.source_url, null);
});
test("FurryFusion host and subdomains with DNS trailing dot cannot render cached URLs", () => {
  for (const host of ["furryfusion.net.", "WWW.FURRYFUSION.NET.", "image.furryfusion.net."]) {
    const [event] = normalizeFurryEvents([{
      name: "旧卡片", start_at: "2026-11-01",
      cover: `https://${host}/cover`, source_url: `https://${host}/event`,
    }]);
    assert.equal(event.cover, null);
    assert.equal(event.source_url, null);
    const dom = new JSDOM("<main></main>");
    const target = dom.window.document.querySelector("main")!;
    appendFurryEventMessage({ target, message: { furryEvents: [event] } });
    assert.equal(target.querySelector("img"), null);
    assert.equal(target.querySelector(".furry-event-action.detail"), null);
    dom.window.close();
  }
  assert.equal(normalizeFurryEvents([{
    name: "FCC", start_at: "2026-11-01", source_url: "https://www.furrycons.cn/event/1",
  }])[0].source_url, "https://www.furrycons.cn/event/1");
});

test("cached legacy Worker cover and detail URLs are never rendered or requested", () => {
  const legacyWorker = "https://sunland-data-worker.liuxizekali.workers.dev";
  const e = normalizeFurryEvents([{
    name: "旧卡片",
    start_at: "2026-11-01",
    cover: `${legacyWorker}/proxy?url=old`,
    source_url: `${legacyWorker}/furry`,
  }])[0];
  assert.equal(e.cover, null);
  assert.equal(e.source_url, null);
  const dom = new JSDOM("<main></main>");
  const target = dom.window.document.querySelector("main")!;
  appendFurryEventMessage({ target, message: { furryEvents: [e] } });
  assert.equal(target.querySelector("img"), null);
  assert.equal(target.querySelector(".furry-event-action.detail"), null);
  assert.doesNotMatch(target.innerHTML, /sunland-data-worker/);
  dom.window.close();
  const absoluteDnsName = normalizeFurryEvents([{
    name: "旧卡片", start_at: "2026-11-01",
    cover: "https://SUNLAND-DATA-WORKER.LIUXIZEKALI.WORKERS.DEV./proxy?url=old",
  }])[0];
  assert.equal(absoluteDnsName.cover, null);

  const allowed = normalizeFurryEvents([{
    name: "FCC 卡片",
    start_at: "2026-11-01",
    cover: "https://project.supabase.co/functions/v1/furry-event-image",
    source_url: "https://www.furrycons.cn/event/example",
  }])[0];
  assert.equal(allowed.cover, "https://project.supabase.co/functions/v1/furry-event-image");
  assert.equal(allowed.source_url, "https://www.furrycons.cn/event/example");
});

test("Web card displays no-details state instead of a retired/empty hyperlink", () => {
  const dom = new JSDOM("<main></main>");
  const target = dom.window.document.querySelector("main");
  appendFurryEventMessage({
    target,
    message: {
      furryEvents: [
        publicEvent(
          { ...row, source_url: "https://www.furryfusion.net/x" },
          endpoint,
        ),
      ],
    },
  });
  assert.match(target!.textContent!, /暂无详情链接/);
  assert.equal(target!.querySelector(".furry-event-action.detail"), null);
});
test('Web card treats hostile event text as text and does not render detail HTML or Markdown', () => {
  const dom = new JSDOM('<main></main>');
  const target = dom.window.document.querySelector('main')!;
  const injected = '<img src=x onerror="window.__fcc_xss=1">';
  const event = publicEvent({ ...row, id: '9007199254740993', name: injected, detail: injected + '[unsafe](javascript:alert(1))', source_url: 'javascript:alert(1)' }, endpoint);
  assert.match(String(event.detail), /onerror/); // API does not sanitize arbitrary HTML.
  appendFurryEventMessage({target, message:{furryEvents:[event]}});
  assert.match(target.textContent!, /<img/);
  assert.equal(target.querySelector('img[src="x"]'), null);
  assert.equal(target.querySelector('script'), null);
  assert.equal(target.querySelector('.furry-event-action.detail'), null);
  assert.equal((dom.window as any).__fcc_xss, undefined);
  dom.window.close();
});
