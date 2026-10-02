import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GithubReleaseRepository } from "../githubReleases.ts";
import { buildRecordSchema, channelRecordSchema } from "../channels.ts";

const bytes = Buffer.from("verified installer");
const checksum = createHash("sha256").update(bytes).digest("hex");
const build = buildRecordSchema.parse({
  schemaVersion: 1,
  buildId: "123",
  version: "0.1.123",
  sourceCommit: "a".repeat(40),
  installers: {
    aarch64: {
      name: "Crystal_0.1.123_darwin-aarch64.dmg",
      size: bytes.length,
      sha256: checksum,
    },
    x86_64: {
      name: "Crystal_0.1.123_darwin-x86_64.dmg",
      size: bytes.length,
      sha256: checksum,
    },
  },
});
const channel = channelRecordSchema.parse({
  schemaVersion: 1,
  channel: "nightly",
  buildId: "123",
  sourceChannel: null,
  actor: "builder",
});

for (const corrupt of [false, true])
  test(`publication validates server checksums before exposing releases and channel pointers (${corrupt ? "corrupt" : "valid"})`, async () => {
    const writes: { path: string; body: unknown }[] = [];
    let created = false;
    let assets: { name: string; size: number; digest: string }[] = [];
    const repository = new GithubReleaseRepository("test-token", {
      gh: (args) => {
        if (args.includes("create")) created = true;
        if (args.includes("upload")) {
          assert.equal(args.includes("--clobber"), false);
          assets = args.slice(args.indexOf("--repo") + 2).map((path) => {
            const file = readFileSync(path);
            return {
              name: path.split("/").at(-1)!,
              size: file.length,
              digest: `sha256:${corrupt ? "0".repeat(64) : createHash("sha256").update(file).digest("hex")}`,
            };
          });
        }
      },
      fetch: async (url, options) => {
        if (String(url).endsWith("/graphql"))
          return Response.json({
            data: {
              repository: {
                release: created
                  ? { databaseId: 1, tagName: "nightly-123" }
                  : null,
              },
            },
          });
        const path = String(url).split("crystal-releases/")[1]!;
        if (options?.method === "GET") {
          if (path.startsWith("contents/") || !created)
            return new Response(null, { status: 404 });
          return Response.json({
            id: 1,
            draft: true,
            prerelease: false,
            tag_name: "nightly-123",
            assets,
          });
        }
        const body = JSON.parse(String(options?.body));
        writes.push({ path, body });
        return Response.json({});
      },
    });
    const publish = repository.publish(build, channel, {
      aarch64: bytes,
      x86_64: bytes,
    });
    if (corrupt) {
      await assert.rejects(publish);
      assert.equal(writes.length, 0);
    } else {
      await publish;
      assert.equal(writes[0]?.path, "releases/1");
      assert.deepEqual(writes[0]?.body, {
        draft: false,
        prerelease: true,
        make_latest: "false",
      });
      assert.equal(writes[1]?.path, "contents/channels/nightly.json");
    }
  });

test("a slow old nightly cannot move the current channel backwards", async () => {
  let created = false;
  let assets: { name: string; size: number; digest: string }[] = [];
  let pointerWrites = 0;
  const repository = new GithubReleaseRepository("test-token", {
    gh: (args) => {
      if (args.includes("create")) created = true;
      if (args.includes("upload"))
        assets = args.slice(args.indexOf("--repo") + 2).map((path) => {
          const file = readFileSync(path);
          return {
            name: path.split("/").at(-1)!,
            size: file.length,
            digest: `sha256:${createHash("sha256").update(file).digest("hex")}`,
          };
        });
    },
    fetch: async (url, options) => {
      if (String(url).endsWith("/graphql"))
        return Response.json({
          data: {
            repository: {
              release: created
                ? { databaseId: 1, tagName: "nightly-123" }
                : null,
            },
          },
        });
      const path = String(url).split("crystal-releases/")[1]!;
      if (options?.method === "GET") {
        if (path.startsWith("contents/"))
          return Response.json({
            sha: "a".repeat(40),
            encoding: "base64",
            content: Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                channel: "nightly",
                buildId: "124",
                version: "0.1.124",
                releaseTag: "nightly-124",
              }),
            ).toString("base64"),
          });
        if (!created) return new Response(null, { status: 404 });
        return Response.json({
          id: 1,
          draft: true,
          prerelease: false,
          tag_name: "nightly-123",
          assets,
        });
      }
      if (path.startsWith("contents/")) pointerWrites++;
      return Response.json({});
    },
  });
  await repository.publish(build, channel, { aarch64: bytes, x86_64: bytes });
  assert.equal(pointerWrites, 0);
});

for (const changed of [false, true])
  test(`interrupted draft uploads resume only matching assets (${changed ? "changed" : "matching"})`, async () => {
    const initial = Buffer.from(`${JSON.stringify(build, null, 2)}\n`);
    const assets = [
      {
        name: "build.json",
        size: initial.length,
        digest: `sha256:${changed ? "0".repeat(64) : createHash("sha256").update(initial).digest("hex")}`,
      },
    ];
    const writes: string[] = [];
    const uploaded: string[] = [];
    const repository = new GithubReleaseRepository("test-token", {
      gh: (args) => {
        assert.equal(args.includes("create"), false);
        assert.equal(args.includes("--clobber"), false);
        assert.equal(args.includes("upload"), true);
        for (const path of args.slice(args.indexOf("--repo") + 2)) {
          const file = readFileSync(path);
          const name = path.split("/").at(-1)!;
          uploaded.push(name);
          assets.push({
            name,
            size: file.length,
            digest: `sha256:${createHash("sha256").update(file).digest("hex")}`,
          });
        }
      },
      fetch: async (url, options) => {
        if (String(url).endsWith("/graphql"))
          return Response.json({
            data: {
              repository: {
                release: { databaseId: 1, tagName: "nightly-123" },
              },
            },
          });
        const path = String(url).split("crystal-releases/")[1]!;
        if (options?.method === "GET") {
          if (path.startsWith("contents/"))
            return new Response(null, { status: 404 });
          assert.equal(path, "releases/1");
          return Response.json({
            id: 1,
            draft: true,
            prerelease: false,
            tag_name: "nightly-123",
            assets,
          });
        }
        writes.push(path);
        return Response.json({});
      },
    });
    const publish = repository.publish(build, channel, {
      aarch64: bytes,
      x86_64: bytes,
    });
    if (changed) {
      await assert.rejects(publish);
      assert.deepEqual(uploaded, []);
      assert.deepEqual(writes, []);
    } else {
      await publish;
      assert.equal(uploaded.length, 4);
      assert.equal(uploaded.includes("build.json"), false);
      assert.deepEqual(writes, [
        "releases/1",
        "contents/channels/nightly.json",
      ]);
    }
  });

test("a published release is verified again and never overwritten on retry", async () => {
  const writes: string[] = [];
  const repository = new GithubReleaseRepository("test-token", {
    gh: (args) => {
      assert.equal(args[1], "download");
      const directory = args[args.indexOf("--dir") + 1]!;
      const patterns = args.flatMap((arg, index) =>
        arg === "--pattern" ? [args[index + 1]!] : [],
      );
      for (const name of patterns) {
        const content =
          name === "build.json"
            ? `${JSON.stringify(build)}\n`
            : name === "channel.json"
              ? `${JSON.stringify(channel)}\n`
              : bytes;
        writeFileSync(join(directory, name), content);
      }
    },
    fetch: async (url, options) => {
      if (String(url).endsWith("/graphql"))
        return Response.json({
          data: {
            repository: { release: { databaseId: 1, tagName: "nightly-123" } },
          },
        });
      const path = String(url).split("crystal-releases/")[1]!;
      if (options?.method === "GET") {
        if (path.startsWith("contents/"))
          return new Response(null, { status: 404 });
        return Response.json({
          id: 1,
          draft: false,
          prerelease: true,
          tag_name: "nightly-123",
          assets: [],
        });
      }
      writes.push(path);
      return Response.json({});
    },
  });
  await repository.publish(build, channel, { aarch64: bytes, x86_64: bytes });
  assert.deepEqual(writes, ["contents/channels/nightly.json"]);
});
