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
