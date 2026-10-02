import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  promoteBuild,
  publishNightly,
  type ReleaseRepository,
} from "../operations.ts";
import { releaseAssets } from "../channels.ts";
import { build, artifacts, nightly } from "./fixtures.ts";

test("both promotion routes preserve every artifact and reject modified installers, archives and signatures", async () => {
  for (const source of ["nightly", "latest"] as const) {
    let publications = 0;
    const sourceRecord =
      source === "nightly"
        ? nightly
        : { ...nightly, channel: "latest", sourceChannel: "nightly" };
    const repository: ReleaseRepository = {
      current: async () => "123",
      read: async (channel, id) => {
        assert.equal(channel, source);
        assert.equal(id, "123");
        return { build, channel: sourceRecord, artifacts };
      },
      publish: async (record, channel, files) => {
        publications++;
        assert.deepEqual(record, build);
        assert.equal(channel.channel, "stable");
        assert.equal(channel.sourceChannel, source);
        assert.deepEqual(files, artifacts);
      },
    };
    const input = {
      target: "stable" as const,
      source,
      buildId: "123",
      actor: "maintainer",
    };
    await promoteBuild(input, repository);
    assert.equal(publications, 1);
    for (const asset of releaseAssets(build)) {
      const corrupted: ReleaseRepository = {
        ...repository,
        read: async () => ({
          build,
          channel: sourceRecord,
          artifacts: {
            ...artifacts,
            [asset.name]: Buffer.from("tampered artifact"),
          },
        }),
      };
      await assert.rejects(promoteBuild(input, corrupted), /checksum/);
      assert.equal(publications, 1);
    }
  }
});

test("nightly requires complete checksummed installer, updater and signature for both architectures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-nightly-test-"));
  let publications = 0;
  const repository: ReleaseRepository = {
    current: async () => "123",
    read: async () => {
      throw new Error("nightly does not promote an earlier release");
    },
    publish: async (record, channel, files) => {
      publications++;
      assert.deepEqual(record, build);
      assert.deepEqual(channel, nightly);
      assert.deepEqual(files, artifacts);
    },
  };
  const input = {
    buildId: "123",
    version: "0.1.123",
    sourceCommit: "a".repeat(40),
    actor: "builder",
    directory,
  };
  try {
    for (const arch of ["aarch64", "x86_64"] as const) {
      const root = join(directory, `crystal-macos-${arch}`);
      await mkdir(root);
      const assets = releaseAssets(build).filter((asset) =>
        asset.name.includes(`darwin-${arch}.`),
      );
      for (const asset of assets)
        await writeFile(join(root, asset.name), artifacts[asset.name]!);
      await writeFile(
        join(root, "SHA256SUMS"),
        assets.map((asset) => `${asset.sha256}  ${asset.name}\n`).join(""),
      );
    }
    await publishNightly(input, repository);
    assert.equal(publications, 1);
    for (const asset of releaseAssets(build)) {
      const arch = asset.name.includes("aarch64") ? "aarch64" : "x86_64";
      await writeFile(
        join(directory, `crystal-macos-${arch}`, asset.name),
        "modified artifact",
      );
      await assert.rejects(publishNightly(input, repository), /checksum/);
      await writeFile(
        join(directory, `crystal-macos-${arch}`, asset.name),
        artifacts[asset.name]!,
      );
      assert.equal(publications, 1);
    }
    await rm(
      join(
        directory,
        "crystal-macos-x86_64",
        `${build.updaters.x86_64.name}.sig`,
      ),
    );
    await assert.rejects(publishNightly(input, repository));
    assert.equal(publications, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omitting a build selects current latest for stable and still checks its provenance", async () => {
  const sources: string[] = [];
  const repository: ReleaseRepository = {
    current: async (source) => {
      sources.push(source);
      return "123";
    },
    read: async (source) => ({
      build,
      channel: { ...nightly, channel: source, sourceChannel: "nightly" },
      artifacts,
    }),
    publish: async (record, channel) => {
      assert.deepEqual(record, build);
      assert.equal(channel.sourceChannel, "latest");
    },
  };
  await promoteBuild({ target: "stable", actor: "maintainer" }, repository);
  assert.deepEqual(sources, ["latest"]);
});
