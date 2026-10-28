import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function runPrivateStep(script: string) {
  const temporary = await mkdtemp(join(tmpdir(), "crystal-log-test-"));
  try {
    await mkdir(join(temporary, "crystal-source"));
    const result = spawnSync(
      "bash",
      [
        fileURLToPath(new URL("../private-step.sh", import.meta.url)),
        "Packaging",
        "bash",
        "-c",
        script,
      ],
      { env: { ...process.env, RUNNER_TEMP: temporary }, encoding: "utf8" },
    );
    assert.deepEqual(await readdir(temporary), ["crystal-source"]);
    assert.equal(result.stderr, "");
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const started = "Packaging started. Private output is suppressed.\n";
const failed =
  "::error::Packaging failed (exit 7). Reproduce in the private source repository for diagnostics.\n";

test("failed private commands disclose neither source output nor retained log files", async () => {
  const result = await runPrivateStep(
    "echo PRIVATE_SOURCE_STDOUT; echo PRIVATE_SOURCE_STDERR >&2; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, started + failed);
});

test("known native tool failures report only their fixed name and numeric exit status", async () => {
  for (const [tool, code] of [
    ["xcrun", 0],
    ["spctl", 3],
    ["codesign", 1],
    ["/usr/bin/codesign", 1],
    ["/usr/bin/hdiutil", 255],
    ["/usr/bin/ditto", 1],
    ["/usr/bin/tar", 2],
    ["/usr/bin/xattr", 1],
    ["/bin/cp", 1],
    ["minisign", 1],
    ["cargo", 101],
    ["pnpm", 1],
  ] as const) {
    const result = await runPrivateStep(
      `printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' '${tool} exited with status ${code}'; exit 7`,
    );
    assert.equal(result.status, 7);
    assert.equal(
      result.stdout,
      started +
        `::error::Packaging native tool failed: ${tool.split("/").at(-1)} (exit ${code}).\n` +
        failed,
    );
  }
});

test("disk image failures report only allowlisted actions and public reasons", async () => {
  for (const [action, reason] of [
    ["convert", "Resource busy"],
    ["resize", "No space left on device"],
    ["attach", "Operation not permitted"],
    ["detach", "Device not configured"],
    ["verify", "Resource busy"],
  ]) {
    const result = await runPrivateStep(
      `printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' 'hdiutil: ${action} failed - ${reason}'; exit 7`,
    );
    assert.equal(result.status, 7);
    assert.equal(
      result.stdout,
      started +
        `::error::Packaging disk image ${action} failed: ${reason}.\n` +
        failed,
    );
  }
});

test("arbitrary errors, private paths and malformed diagnostic lookalikes stay suppressed", async () => {
  const lines = [
    "PRIVATE_SECRET",
    "/private/source/spctl exited with status 1",
    "curl exited with status 1",
    "xcrun exited with status 256",
    "xcrun exited with status -1",
    "xcrun exited with status 01",
    "xcrun exited with status 1 PRIVATE_SECRET",
    "PRIVATE_SECRET spctl exited with status 1",
    "hdiutil: PRIVATE_SECRET failed - Resource busy",
    "hdiutil: convert failed - PRIVATE_SECRET",
    "hdiutil: convert failed - Resource busy /private/source/file.ts",
    "hdiutil: convert failed - Resource busy::error::PRIVATE_SECRET",
  ];
  const result = await runPrivateStep(
    `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}; exit 7`,
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, started + failed);
});

test("success preserves its original summary and suppresses all private output", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' 'spctl exited with status 3'; exit 0",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, started + "Packaging passed.\n");
});
