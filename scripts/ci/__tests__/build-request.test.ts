import assert from "node:assert/strict";
import test from "node:test";
import { parseBuildRequest, resolveBuildRequest } from "../cli.ts";
import { build } from "../../release/__tests__/fixtures.ts";

const commit = "a".repeat(40);
const helper = "b".repeat(40);
const manual = {
  inputs: { source_ref: "codex/native-release-ci", version: "0.1.0" },
};
const dispatch = {
  action: "crystal-native-build",
  sender: { type: "Bot", login: "crystal-release-publisher[bot]" },
  client_payload: {
    source_repository: "crystal-inc/crystal",
    build_kind: "test",
    source_sha: commit,
    version: "0.1.0",
  },
};

test("maintainer reference is resolved once before both architecture builds", async () => {
  const calls: string[] = [];
  const responses = [
    { sha: commit },
    {
      sha: helper,
      submodule_git_url: "git@github.com:crystal-inc/crystal-server.git",
    },
    { sha: helper },
  ];
  const result = await resolveBuildRequest(
    parseBuildRequest("workflow_dispatch", manual),
    "test-token",
    async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, "Bearer test-token");
      return { ok: true, json: async () => responses.shift() };
    },
  );
  assert.deepEqual(result, { commit, version: "0.1.0", kind: "test" });
  assert.equal(calls.length, 3);
  assert.match(calls[1], new RegExp(`ref=${commit}$`));
  assert.match(calls[2], new RegExp(`/crystal-server/commits/${helper}$`));
});

test("only the configured App can dispatch private source commits", () => {
  assert.deepEqual(
    parseBuildRequest(
      "repository_dispatch",
      dispatch,
      "crystal-release-publisher",
    ),
    { sourceRef: commit, version: "0.1.0", kind: "test" },
  );
  for (const event of [
    {
      ...dispatch,
      sender: { type: "User", login: "crystal-release-publisher[bot]" },
    },
    { ...dispatch, sender: { type: "Bot", login: "other-app[bot]" } },
    {
      ...dispatch,
      client_payload: {
        ...dispatch.client_payload,
        source_repository: "someone/fork",
      },
    },
    {
      ...dispatch,
      client_payload: { ...dispatch.client_payload, source_sha: "main" },
    },
  ])
    assert.throws(() =>
      parseBuildRequest(
        "repository_dispatch",
        event,
        "crystal-release-publisher",
      ),
    );
  assert.throws(() => parseBuildRequest("pull_request", manual));
});

test("untrusted references and versions cannot escape the input boundary", () => {
  for (const source_ref of [
    "",
    "--upload-pack=bad",
    "main\nother",
    "main\n",
    "../main",
    "main$(id)",
    "https://github.com/other/repo",
    "main?ref=other",
  ])
    assert.throws(() =>
      parseBuildRequest("workflow_dispatch", {
        inputs: { ...manual.inputs, source_ref },
      }),
    );
  for (const version of [
    "",
    "v0.1.0",
    "01.0.0",
    "0.1.0\nother",
    "0.1.0\n",
    "0.1.0;id",
  ])
    assert.throws(() =>
      parseBuildRequest("workflow_dispatch", {
        inputs: { ...manual.inputs, version },
      }),
    );
});

test("source access errors never include a private API response body", async () => {
  await assert.rejects(
    resolveBuildRequest(
      { sourceRef: "main", version: "0.1.0", kind: "test" },
      "test-token",
      async () => ({
        ok: false,
        status: 403,
        json: async () => {
          throw new Error("PRIVATE SOURCE");
        },
      }),
    ),
    { message: "Private source access failed (HTTP 403)" },
  );
});

test("helper must be the expected repository and accessible pinned commit", async () => {
  for (const repository of ["git@github.com:someone/other.git", undefined]) {
    const responses = [
      { sha: commit },
      { sha: helper, submodule_git_url: repository },
    ];
    await assert.rejects(
      resolveBuildRequest(
        { sourceRef: "main", version: "0.1.0", kind: "test" },
        "test-token",
        async () => ({ ok: true, json: async () => responses.shift() }),
      ),
      /unexpected helper/,
    );
  }
});

test("nightly bumps the published channel version with its own read token", async () => {
  for (const [base, bump, expected] of [
    ["0.1.23", "patch", "0.1.24"],
    ["0.1.23", "minor", "0.2.0"],
    ["0.1.23", "major", "1.0.0"],
    ["0.2.0", "patch", "0.2.1"],
    ["1.0.0", "patch", "1.0.1"],
  ]) {
    const responses: unknown[] = [
      { sha: commit },
      {
        sha: helper,
        submodule_git_url: "git@github.com:crystal-inc/crystal-server.git",
      },
      { sha: helper },
      {
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            channel: "nightly",
            version: base,
          }),
        ).toString("base64"),
      },
    ];
    const request = parseBuildRequest(
      "repository_dispatch",
      {
        ...dispatch,
        client_payload: {
          ...dispatch.client_payload,
          build_kind: "nightly",
          bump,
        },
      },
      "crystal-release-publisher",
    );
    const result = await resolveBuildRequest(
      request,
      "test-token",
      async (url, options) => {
        const channelRequest = url.includes(
          "crystal-releases/contents/channels/nightly.json?ref=main",
        );
        assert.equal(
          options.headers.Authorization,
          channelRequest ? "Bearer channel-token" : "Bearer test-token",
        );
        if (responses.length === 1) assert.equal(channelRequest, true);
        return { ok: true, json: async () => responses.shift() };
      },
      "channel-token",
    );
    assert.deepEqual(result, { commit, version: expected, kind: "nightly" });
  }
});

test("scheduled nightly defaults to patch and does not need a typed installer version", () => {
  const request = parseBuildRequest(
    "repository_dispatch",
    {
      ...dispatch,
      client_payload: {
        source_repository: "crystal-inc/crystal",
        source_sha: commit,
        build_kind: "nightly",
      },
    },
    "crystal-release-publisher",
  );
  assert.deepEqual(request, {
    sourceRef: commit,
    kind: "nightly",
    bump: "patch",
  });
});

test("nightly rejects an unsupported bump before resolving source", () => {
  for (const bump of ["", "auto", "patch\n", "1.0.0", "patch;id"])
    assert.throws(() =>
      parseBuildRequest(
        "repository_dispatch",
        {
          ...dispatch,
          client_payload: {
            ...dispatch.client_payload,
            build_kind: "nightly",
            bump,
          },
        },
        "crystal-release-publisher",
      ),
    );
});

test("nightly fails closed on an unavailable or invalid published channel", async () => {
  const request = parseBuildRequest(
    "repository_dispatch",
    {
      ...dispatch,
      client_payload: { ...dispatch.client_payload, build_kind: "nightly" },
    },
    "crystal-release-publisher",
  );
  for (const channel of [
    null,
    { schemaVersion: 1, channel: "stable", version: "1.0.0" },
    { schemaVersion: 1, channel: "nightly", version: "v0.1.23" },
  ]) {
    const responses: unknown[] = [
      { sha: commit },
      {
        sha: helper,
        submodule_git_url: "git@github.com:crystal-inc/crystal-server.git",
      },
      { sha: helper },
      {
        encoding: "base64",
        content: Buffer.from(JSON.stringify(channel)).toString("base64"),
      },
    ];
    await assert.rejects(
      resolveBuildRequest(
        request,
        "test-token",
        async () => ({ ok: true, json: async () => responses.shift() }),
        "channel-token",
      ),
      /Published nightly version is invalid/,
    );
  }
});

test("manual builds cannot request nightly publication", () => {
  assert.equal(
    parseBuildRequest("workflow_dispatch", {
      inputs: { ...manual.inputs, build_kind: "nightly" },
    }).kind,
    "test",
  );
  assert.throws(() =>
    parseBuildRequest(
      "repository_dispatch",
      {
        ...dispatch,
        client_payload: { ...dispatch.client_payload, build_kind: "stable" },
      },
      "crystal-release-publisher",
    ),
  );
});

test("rerunning a published nightly retains its immutable version", async () => {
  const request = parseBuildRequest(
    "repository_dispatch",
    {
      ...dispatch,
      client_payload: {
        ...dispatch.client_payload,
        build_kind: "nightly",
        bump: "major",
      },
    },
    "crystal-release-publisher",
  );
  const responses: unknown[] = [
    { sha: commit },
    {
      sha: helper,
      submodule_git_url: "git@github.com:crystal-inc/crystal-server.git",
    },
    { sha: helper },
    { data: { repository: { release: { databaseId: 7 } } } },
    { assets: [{ id: 8, name: "build.json" }] },
    build,
  ];
  const result = await resolveBuildRequest(
    request,
    "test-token",
    async (url, options) => {
      assert.equal(
        options.headers.Authorization,
        responses.length > 3 ? "Bearer test-token" : "Bearer channel-token",
      );
      if (url.endsWith("/graphql")) {
        assert.equal(options.method, "POST");
        assert.equal(JSON.parse(options.body!).variables.tag, "nightly-123");
      }
      if (url.endsWith("/assets/8"))
        assert.equal(options.headers.Accept, "application/octet-stream");
      return { ok: true, json: async () => responses.shift() };
    },
    "channel-token",
    "123",
  );
  assert.deepEqual(result, { commit, version: build.version, kind: "nightly" });
  assert.equal(responses.length, 0);
});
