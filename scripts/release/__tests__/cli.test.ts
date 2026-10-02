import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseCommand } from "../cli.ts";
import type { ReleaseRepository } from "../operations.ts";
import { build, artifacts, nightly } from "./fixtures.ts";

test("CLI retains default and explicit promotion routes using verified repository operations", async (context) => {
  const previousActor = process.env.GITHUB_ACTOR;
  process.env.GITHUB_ACTOR = "maintainer";
  context.after(() => {
    if (previousActor === undefined) delete process.env.GITHUB_ACTOR;
    else process.env.GITHUB_ACTOR = previousActor;
  });
  for (const [rawArgs, source, destination] of [
    [["promote", "--target", "latest"], "nightly", "latest"],
    [["promote", "--target", "stable", "--build", ""], "latest", "stable"],
    [
      [
        "promote",
        "--target",
        "stable",
        "--source",
        "nightly",
        "--build",
        build.buildId,
      ],
      "nightly",
      "stable",
    ],
  ] as const) {
    let publications = 0;
    const repository: ReleaseRepository = {
      async current(channel) {
        assert.equal(channel, source);
        return build.buildId;
      },
      async read(channel, buildId) {
        assert.equal(channel, source);
        assert.equal(buildId, build.buildId);
        return {
          build,
          artifacts,
          channel:
            source === "nightly"
              ? nightly
              : { ...nightly, channel: "latest", sourceChannel: "nightly" },
        };
      },
      async publish(selected, channel, files) {
        assert.deepEqual(selected, build);
        assert.equal(channel.channel, destination);
        assert.equal(channel.sourceChannel, source);
        assert.deepEqual(files, artifacts);
        publications++;
      },
    };
    await createReleaseCommand(() => repository).parseAsync([...rawArgs], {
      from: "user",
    });
    assert.equal(publications, 1);
  }
});

test("CLI rejects invalid arguments before accessing credentials or a release repository", async () => {
  let connections = 0;
  const command = createReleaseCommand(() => {
    connections++;
    throw new Error("Must not connect");
  });
  for (const rawArgs of [
    [],
    ["unknown"],
    ["nightly", "extra"],
    ["nightly", "--target", "stable"],
    ["promote"],
    ["promote", "--target", "invalid"],
    ["promote", "--target", "stable", "--soruce", "nightly"],
    ["promote", "--target", "stable", "extra"],
    ["promote", "--target", "stable", "--source"],
    ["promote", "--target", "stable", "--build", "../123"],
  ]) {
    for (const child of [command, ...command.commands])
      child.exitOverride().configureOutput({
        writeOut: () => undefined,
        writeErr: () => undefined,
      });
    await assert.rejects(command.parseAsync(rawArgs, { from: "user" }));
  }
  assert.equal(connections, 0);
});
