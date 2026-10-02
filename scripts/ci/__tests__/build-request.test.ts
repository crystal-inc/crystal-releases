import assert from "node:assert/strict";
import test from "node:test";
import { parseBuildRequest, resolveBuildRequest } from "../cli.ts";

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
  assert.deepEqual(result, { commit, version: "0.1.0" });
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
    { sourceRef: commit, version: "0.1.0" },
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
      { sourceRef: "main", version: "0.1.0" },
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
        { sourceRef: "main", version: "0.1.0" },
        "test-token",
        async () => ({ ok: true, json: async () => responses.shift() }),
      ),
      /unexpected helper/,
    );
  }
});
