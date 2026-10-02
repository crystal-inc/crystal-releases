import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  promoteBuild,
  publishNightly,
  type ReleaseRepository,
} from "../operations.ts";

const bytes = Buffer.from("same verified binary");
const makeAsset = (arch: string) => ({
  name: `Crystal_0.1.123_darwin-${arch}.dmg`,
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const build = {
  schemaVersion: 1,
  buildId: "123",
  version: "0.1.123",
  sourceCommit: "a".repeat(40),
  installers: { aarch64: makeAsset("aarch64"), x86_64: makeAsset("x86_64") },
};
const nightly = {
  schemaVersion: 1,
  channel: "nightly",
  buildId: "123",
  sourceChannel: null,
  actor: "builder",
};

test("both promotion routes publish the same bytes and fail closed on a modified installer", async () => {
  for (const source of ["nightly", "latest"] as const) {
    let publications = 0;
    const repository: ReleaseRepository = {
      current: async () => "123",
      read: async (channel, id) => {
        assert.equal(channel, source);
        assert.equal(id, "123");
        return {
          build,
          channel:
            source === "nightly"
              ? nightly
              : { ...nightly, channel: "latest", sourceChannel: "nightly" },
          installers: { aarch64: bytes, x86_64: bytes },
        };
      },
      publish: async (record, channel, installers) => {
        publications++;
        assert.deepEqual(record, build);
        assert.equal(channel.channel, "stable");
        assert.equal(channel.sourceChannel, source);
        assert.deepEqual(installers, { aarch64: bytes, x86_64: bytes });
      },
    };
    await promoteBuild(
      { target: "stable", source, buildId: "123", actor: "maintainer" },
      repository,
    );
    assert.equal(publications, 1);
    const corrupted: ReleaseRepository = {
      ...repository,
      read: async () => ({
        build,
        channel: nightly,
        installers: {
          aarch64: bytes,
          x86_64: Buffer.from("tampered installer"),
        },
      }),
    };
    await assert.rejects(
      promoteBuild(
        {
          target: "stable",
          source: "nightly",
          buildId: "123",
          actor: "maintainer",
        },
        corrupted,
      ),
      /checksum/,
    );
    assert.equal(publications, 1);
  }
});

test("nightly publication requires checksum-verified installers for both architectures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-nightly-test-"));
  let publications = 0;
  const repository: ReleaseRepository = {
    current: async () => "123",
    read: async () => {
      throw new Error("nightly does not promote an earlier release");
    },
    publish: async (record, channel, installers) => {
      publications++;
      assert.deepEqual(record, build);
      assert.deepEqual(channel, nightly);
      assert.deepEqual(installers, { aarch64: bytes, x86_64: bytes });
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
      await writeFile(join(root, build.installers[arch].name), bytes);
      await writeFile(
        join(root, "SHA256SUMS"),
        `${build.installers[arch].sha256}  ${build.installers[arch].name}\n`,
      );
    }
    await publishNightly(input, repository);
    assert.equal(publications, 1);
    await writeFile(
      join(directory, "crystal-macos-x86_64", build.installers.x86_64.name),
      "modified installer",
    );
    await assert.rejects(publishNightly(input, repository), /checksum/);
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
      installers: { aarch64: bytes, x86_64: bytes },
    }),
    publish: async (record, channel) => {
      assert.deepEqual(record, build);
      assert.equal(channel.sourceChannel, "latest");
    },
  };
  await promoteBuild({ target: "stable", actor: "maintainer" }, repository);
  assert.deepEqual(sources, ["latest"]);
});
