import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

test("the only deployable FCC migration matches the isolated SQL and excludes the archived conflicting migration", async () => {
  const migrations = await readdir("supabase/migrations");
  const matches = migrations.filter((name) => /^\d+_fcc_simple_replace\.sql$/.test(name));
  assert.equal(matches.length, 1);
  assert.deepEqual(migrations.filter((name) => /fcc/i.test(name) && name.endsWith(".sql")), matches);
  assert.ok(!migrations.includes("20261027061449_fcc_safe_ingestion.sql"));
  const [review, deployable] = await Promise.all([
    readFile("sql/review/fcc_simple_replace.sql"),
    readFile(`supabase/migrations/${matches[0]}`),
  ]);
  assert.ok(review.length > 0);
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(deployable), digest(review), "deployable SQL differs from reviewed SQL");
});
