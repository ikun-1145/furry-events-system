import { readFile, writeFile } from "node:fs/promises";
import { inspectFcc } from "./fcc-readonly.ts";
async function main() {
  const [backupPath, outputPath] = process.argv.slice(2);
  if (!backupPath || !outputPath) throw Error("Arguments required");
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  if (!Array.isArray(backup.rows)) throw Error("Invalid backup");
  const report = await inspectFcc(process.env.FCC_API_TOKEN ?? "", backup.rows);
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      status: report.status,
      real_api_verified: report.real_api_verified,
    }),
  );
  if (!report.real_api_verified) process.exitCode = 2;
}
main().catch(() => {
  console.error(
    "READONLY_CHECK_FAILED: check arguments/output path; no credential or response body logged",
  );
  process.exitCode = 1;
});
