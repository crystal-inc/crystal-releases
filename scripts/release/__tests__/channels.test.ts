import assert from "node:assert/strict";
import test from "node:test";
import {
  requirePromotion,
  verifyAsset,
  createUpdateManifest,
  verifyArtifacts,
} from "../channels.ts";

import { build, bytes, nightly, artifacts } from "./fixtures.ts";

test("normal promotion preserves the build through nightly, latest and stable", () => {
  const latest = requirePromotion({
    target: "latest",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  const stable = requirePromotion({
    target: "stable",
    sourceRecord: latest.channel,
    build: latest.build,
    actor: "maintainer",
  });
  assert.deepEqual(latest.build, build);
  assert.deepEqual(stable.build, build);
  assert.equal(stable.channel.sourceChannel, "latest");
  assert.equal(stable.channel.buildId, "123");
});

test("stable defaults to latest and allows nightly only when explicitly selected", () => {
  assert.throws(() =>
    requirePromotion({
      target: "stable",
      sourceRecord: nightly,
      build,
      actor: "maintainer",
    }),
  );
  const stable = requirePromotion({
    target: "stable",
    source: "nightly",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  assert.equal(stable.channel.sourceChannel, "nightly");
  assert.deepEqual(stable.build, build);
});

test("source selection never bypasses build identity or installer verification", () => {
  assert.throws(() =>
    requirePromotion({
      target: "stable",
      source: "nightly",
      sourceRecord: { ...nightly, buildId: "124" },
      build,
      actor: "maintainer",
    }),
  );
  const result = requirePromotion({
    target: "latest",
    sourceRecord: nightly,
    build,
    actor: "maintainer",
  });
  verifyAsset(bytes, result.build.installers.aarch64);
  assert.throws(() =>
    verifyAsset(Buffer.from("modified app"), result.build.installers.aarch64),
  );
  assert.throws(() =>
    requirePromotion({
      target: "latest",
      source: "latest",
      sourceRecord: result.channel,
      build,
      actor: "maintainer",
    }),
  );
});

test("invalid build records and unrelated source channels cannot be promoted", () => {
  for (const invalid of [
    null,
    {},
    { ...build, version: "0.1.123;bad" },
    { ...build, installers: { aarch64: build.installers.aarch64 } },
  ])
    assert.throws(() =>
      requirePromotion({
        target: "latest",
        sourceRecord: nightly,
        build: invalid,
        actor: "maintainer",
      }),
    );
  assert.throws(() =>
    requirePromotion({
      target: "latest",
      sourceRecord: { ...nightly, channel: "stable", sourceChannel: "latest" },
      build,
      actor: "maintainer",
    }),
  );
});

test("build IDs reject whitespace, path fragments and option-like values at the boundary", () => {
  for (const buildId of ["123\n", " 123", "../123", "--123", "0"]) {
    const candidate = { ...build, buildId };
    assert.throws(() =>
      requirePromotion({
        target: "latest",
        sourceRecord: { ...nightly, buildId },
        build: candidate,
        actor: "maintainer",
      }),
    );
  }
});

test("update manifests use verified signatures and support another HTTPS storage provider", () => {
  for (const baseUrl of [
    "https://github.com/crystal-inc/crystal-releases/releases/download/stable-123",
    "https://downloads.example.com/0.1.123/",
  ]) {
    const manifest = createUpdateManifest(build, {
      kind: "static-http",
      baseUrl,
    });
    assert.deepEqual(manifest.installationPolicy, { kind: "automatic" });
    const arm = manifest.platforms["darwin-aarch64"]!;
    assert.equal(arm.signature, build.updaters.aarch64.signature);
    assert.equal(arm.sha256, build.updaters.aarch64.sha256);
    assert.equal(
      arm.url,
      `${baseUrl.replace(/\/$/u, "")}/${build.updaters.aarch64.name}`,
    );
  }
  for (const baseUrl of [
    "http://downloads.example.com",
    "https://user:password@example.com",
    "https://example.com?token=x",
    "https://example.com#fragment",
  ])
    assert.throws(
      () => createUpdateManifest(build, { kind: "static-http", baseUrl }),
      /HTTPS/,
    );
});

test("signature files are bound to the updater metadata and extra files cannot be promoted", () => {
  const tampered = structuredClone(build);
  tampered.updaters.aarch64.signature = Buffer.from(
    "different signature",
  ).toString("base64");
  assert.throws(() => verifyArtifacts(tampered, artifacts), /checksum/);
  assert.throws(
    () => verifyArtifacts(build, { ...artifacts, "private.ts": bytes }),
    /allowlist/,
  );
});
