import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyStableRelease,
  ReleaseNotificationError,
} from "../release-notify.ts";
import { ciFailureMessage } from "../cli.ts";

const input = {
  url: "https://api.crystal.design/app-updates/notify",
  oidcUrl: "https://issuer.example/token",
  oidcToken: "PRIVATE_REQUEST_TOKEN",
  revision: "a".repeat(40),
};

test("OIDC HTTP failures expose only their operation and bounded status through the CLI", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return new Response("PRIVATE_PASSWORD https://secret.example/source", {
      status: 403,
    });
  };
  await assert.rejects(
    notifyStableRelease(input, request),
    (error: unknown) => {
      assert.equal(
        ciFailureMessage(error),
        "Release notification failed: operation=oidc reason=http status=403",
      );
      assert.doesNotMatch(ciFailureMessage(error), /PRIVATE|https:|secret/u);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("receiver HTTP failures preserve retry behavior and expose no response data", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return calls === 1
      ? Response.json({ value: "PRIVATE_SIGNED_TOKEN" })
      : new Response("PRIVATE_PASSWORD https://secret.example/source", {
          status: 530,
        });
  };
  await assert.rejects(
    notifyStableRelease(input, request),
    (error: unknown) => {
      assert.equal(
        ciFailureMessage(error),
        "Release notification failed: operation=notify reason=http status=530",
      );
      assert.doesNotMatch(ciFailureMessage(error), /PRIVATE|https:|secret/u);
      return true;
    },
  );
  assert.equal(calls, 4);
});

test("OIDC transport and invalid token responses never surface credentials or body text", async () => {
  for (const [reason, request] of [
    [
      "transport",
      async () => {
        throw new Error(
          "PRIVATE_PASSWORD https://secret.example?token=PRIVATE_REQUEST_TOKEN",
        );
      },
    ],
    [
      "response",
      async () => Response.json({ value: "", privateBody: "PRIVATE_PASSWORD" }),
    ],
  ] as const) {
    await assert.rejects(
      notifyStableRelease(input, request),
      (error: unknown) => {
        assert.equal(
          ciFailureMessage(error),
          `Release notification failed: operation=oidc reason=${reason}`,
        );
        assert.doesNotMatch(ciFailureMessage(error), /PRIVATE|https:|secret/u);
        return true;
      },
    );
  }
});

test("receiver transport, malformed responses and stale revisions remain distinguishable without values", async () => {
  for (const [reason, reply] of [
    [
      "transport",
      async () => {
        throw new Error("PRIVATE_PASSWORD https://secret.example/source");
      },
    ],
    [
      "response",
      async () => new Response("PRIVATE_BODY https://secret.example/source"),
    ],
    [
      "revision",
      async () =>
        Response.json({
          revision: "PRIVATE_REVISION",
          token: "PRIVATE_PASSWORD",
        }),
    ],
  ] as const) {
    let calls = 0;
    const request: typeof fetch = async () =>
      ++calls === 1
        ? Response.json({ value: "PRIVATE_SIGNED_TOKEN" })
        : reply();
    await assert.rejects(
      notifyStableRelease(input, request),
      (error: unknown) => {
        assert.equal(
          ciFailureMessage(error),
          `Release notification failed: operation=notify reason=${reason}`,
        );
        assert.doesNotMatch(ciFailureMessage(error), /PRIVATE|https:|secret/u);
        return true;
      },
    );
    assert.equal(calls, 4);
  }
});

test("unknown errors and forged diagnostic lookalikes keep the generic CLI failure", () => {
  const generic =
    "CI preparation failed; verify the command, configuration and source access.";
  for (const error of [
    new Error(
      "Release notification failed: operation=notify reason=http status=403 PRIVATE_PASSWORD https://secret.example",
    ),
    { failure: { operation: "notify", reason: "http", status: 403 } },
    Object.assign(new Error("PRIVATE_REQUEST_TOKEN"), {
      failure: { operation: "notify", reason: "http", status: 403 },
    }),
  ])
    assert.equal(ciFailureMessage(error), generic);
});

test("typed diagnostics reject malformed fields and ignore secret-bearing error messages", () => {
  const failure = new ReleaseNotificationError({
    operation: "notify",
    reason: "http",
    status: 403,
  });
  failure.message = "PRIVATE_TOKEN https://secret.example/source";
  assert.equal(
    ciFailureMessage(failure),
    "Release notification failed: operation=notify reason=http status=403",
  );
  for (const fields of [
    { operation: "notify", reason: "http", status: 999 },
    { operation: "https://secret.example", reason: "http", status: 403 },
    { operation: "notify", reason: "PRIVATE_PASSWORD", status: 403 },
    { operation: "notify", reason: "http", status: 403, body: "PRIVATE_TOKEN" },
  ]) {
    Reflect.set(failure, "failure", fields);
    assert.equal(
      ciFailureMessage(failure),
      "CI preparation failed; verify the command, configuration and source access.",
    );
  }
});

test("hostile getters and proxies cannot escape the generic CLI failure", () => {
  const privateError = () => {
    throw new Error("PRIVATE_GETTER_SECRET https://secret.example/source");
  };
  const getterFailure = new ReleaseNotificationError({
    operation: "notify",
    reason: "http",
    status: 403,
  });
  Object.defineProperty(getterFailure, "failure", { get: privateError });
  const fieldGetterFailure = new ReleaseNotificationError({
    operation: "notify",
    reason: "http",
    status: 403,
  });
  Object.defineProperty(fieldGetterFailure.failure, "operation", {
    get: privateError,
  });
  const prototypeProxy = new Proxy({}, { getPrototypeOf: privateError });
  const fieldProxy = new Proxy(
    new ReleaseNotificationError({
      operation: "notify",
      reason: "http",
      status: 403,
    }),
    {
      get(target, key, receiver) {
        if (key === "failure") return privateError();
        return Reflect.get(target, key, receiver);
      },
    },
  );
  for (const error of [
    getterFailure,
    fieldGetterFailure,
    prototypeProxy,
    fieldProxy,
  ]) {
    assert.doesNotThrow(() => {
      assert.equal(
        ciFailureMessage(error),
        "CI preparation failed; verify the command, configuration and source access.",
      );
    });
  }
});
