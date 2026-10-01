import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("failed private commands disclose neither source output nor retained log files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "crystal-log-test-"));
  try {
    await mkdir(join(temporary, "crystal-source"));
    const result = spawnSync(
      "bash",
      [
        fileURLToPath(new URL("./private-step.sh", import.meta.url)),
        "Tests",
        "bash",
        "-c",
        "echo PRIVATE_SOURCE_STDOUT; echo PRIVATE_SOURCE_STDERR >&2; exit 7",
      ],
      { env: { ...process.env, RUNNER_TEMP: temporary }, encoding: "utf8" },
    );
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Tests failed \(exit 7\)/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_SOURCE/);
    assert.deepEqual(await readdir(temporary), ["crystal-source"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
