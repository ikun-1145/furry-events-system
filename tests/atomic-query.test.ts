import test from "node:test";
import assert from "node:assert/strict";
import { readAtomicRows } from "../supabase/functions/_shared/query_repository.ts";

test("one atomic read preserves bigint identifiers and rejects an incomplete or unordered response", async () => {
  let calls = 0;
  const rows = [{ id: "9007199254740993" }, { id: "9007199254740994" }];
  const result = await readAtomicRows(async () => {
    calls++;
    return rows;
  }, {}, new Date("2026-10-28T00:00:00Z"));
  assert.equal(calls, 1);
  assert.deepEqual(result, rows);
  for (const invalid of [
    [{ id: "2" }, { id: "1" }],
    [{ id: "1" }, { id: "1" }],
    [{ id: 9007199254740993 }],
    [{}],
  ]) {
    await assert.rejects(readAtomicRows(async () => invalid, {}, new Date()), /INVALID_DATABASE_ID/);
  }
  await assert.rejects(readAtomicRows(async () => null, {}, new Date()), /INVALID_DATABASE_PAGE/);
  await assert.rejects(
    readAtomicRows(async () => Array.from({ length: 10001 }, (_, i) => ({ id: String(i + 1) })), {}, new Date()),
    /INVALID_DATABASE_PAGE/,
  );
});
