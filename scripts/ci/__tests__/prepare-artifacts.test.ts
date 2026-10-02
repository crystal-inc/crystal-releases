import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("only the requested DMG and checksum leave the private output directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "crystal-artifact-test-"));
  const commit = "a".repeat(40);
  const installer = "Crystal_0.1.0_darwin-aarch64.dmg";
  const bytes = Buffer.from("test installer bytes");
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("../cli.ts", import.meta.url).pathname,
        "artifacts",
      ],
      {
        env: {
          ...process.env,
          RUNNER_TEMP: temporary,
          CRYSTAL_RELEASE_VERSION: "0.1.0",
          CRYSTAL_SOURCE_SHA: commit,
          CRYSTAL_BUILD_ARCH: "aarch64",
        },
        encoding: "utf8",
      },
    );
  try {
    const source = join(temporary, "crystal-release");
    await mkdir(source);
    await writeFile(join(source, installer), bytes);
    await writeFile(join(source, "private-source.ts"), "must not be uploaded");
    await writeFile(
      join(source, "Crystal_0.1.0_darwin-aarch64.app.tar.gz"),
      "unsigned archive",
    );
    const metadata = {
      version: "0.1.0",
      architecture: "aarch64",
      appSigning: "adhoc",
      updaterSigning: "unsigned",
      commit,
    };
    const metadataPath = join(source, "build-aarch64.json");
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, commit: "b".repeat(40) }),
    );
    assert.notEqual(run().status, 0, "wrong source commit must be rejected");
    for (const invalid of [
      null,
      {},
      { ...metadata, appSigning: "developer-id" },
      { ...metadata, updaterSigning: "signed" },
    ]) {
      await writeFile(metadataPath, JSON.stringify(invalid));
      assert.notEqual(run().status, 0, "unexpected metadata must be rejected");
    }
    const destination = join(temporary, "crystal-public-artifacts");
    await mkdir(destination);
    await writeFile(
      join(destination, "stale-private-file.ts"),
      "must not leave CI",
    );
    await writeFile(metadataPath, JSON.stringify(metadata));
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (await readdir(destination)).sort(),
      [installer, "SHA256SUMS"].sort(),
    );
    assert.equal(
      await readFile(join(destination, "SHA256SUMS"), "utf8"),
      `${createHash("sha256").update(bytes).digest("hex")}  ${installer}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
