import assert from "node:assert/strict";
import test from "node:test";
import { notifyStableRelease } from "../release-notify.ts";

const input = {
  url: "https://api.crystal.design/app-updates/notify",
  oidcUrl: "https://issuer.example/token?existing=1",
  oidcToken: "request-secret",
  revision: "a".repeat(40),
};

test("uses a short-lived audience-bound token and requires the published revision, retrying a stale source", async () => {
  const calls: { url: URL; options: RequestInit | undefined }[] = [];
  const request: typeof fetch = async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    if (calls.length === 1) return Response.json({ value: "signed-jwt" });
    return Response.json({
      revision: calls.length === 2 ? "old" : input.revision,
    });
  };
  await notifyStableRelease(input, request);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url.searchParams.get("audience"), input.url);
  assert.equal(calls[0]!.url.searchParams.get("existing"), "1");
  assert.deepEqual(calls[0]!.options!.headers, {
    Authorization: "Bearer request-secret",
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.url.href, input.url);
    assert.equal(call.options!.method, "POST");
    assert.deepEqual(call.options!.headers, {
      Authorization: "Bearer signed-jwt",
      "Content-Type": "application/json",
    });
    assert.equal(call.options!.redirect, "error");
  }
});

test("a rejected token request never reaches the notification receiver or leaks its response", async () => {
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return new Response("private diagnostic", { status: 403 });
  };
  await assert.rejects(
    notifyStableRelease(input, request),
    /^Error: Release OIDC request failed$/,
  );
  assert.equal(calls, 1);
});

test("rejects insecure destinations before transmitting credentials", async () => {
  const request: typeof fetch = async () => {
    throw new Error("must not call fetch");
  };
  for (const field of ["url", "oidcUrl"]) {
    await assert.rejects(
      notifyStableRelease({ ...input, [field]: "http://example.com" }, request),
      /requires HTTPS/,
    );
  }
});
