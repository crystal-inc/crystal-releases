import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { releaseAnalyticsEnv } from "../analytics-env.ts";

const ready = {
  VITE_ANALYTICS_MODE: "remote",
  VITE_POSTHOG_KEY: "phc_test",
  VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
  VITE_SENTRY_DSN: "https://public@o1.ingest.de.sentry.io/2",
  VITE_APP_BUILD: "0.1.1+0123456789abcdef",
  SENTRY_AUTH_TOKEN: "private-token-sentinel",
  SENTRY_ORG: "crystal-wc",
  SENTRY_PROJECT: "crystal-desktop",
};

test("default and explicit local builds do not activate symbol uploads", () => {
  assert.equal(releaseAnalyticsEnv({}).VITE_ANALYTICS_MODE, "local");
  const local = releaseAnalyticsEnv({ ...ready, VITE_ANALYTICS_MODE: "local", KEEP: "unchanged" });
  assert.equal(local.SENTRY_AUTH_TOKEN, undefined);
  assert.equal(local.VITE_POSTHOG_KEY, ready.VITE_POSTHOG_KEY);
  assert.equal(local.KEEP, "unchanged");
  assert.equal(ready.SENTRY_AUTH_TOKEN, "private-token-sentinel");
});

test("GitHub empty optional values become absent, matching the source build contract", () => {
  const local = releaseAnalyticsEnv({ VITE_POSTHOG_KEY: "", VITE_SENTRY_DSN: "", SENTRY_AUTH_TOKEN: "" });
  assert.equal(local.VITE_POSTHOG_KEY, undefined);
  assert.equal(local.VITE_SENTRY_DSN, undefined);
  assert.equal(local.SENTRY_AUTH_TOKEN, undefined);
});

test("a remote build requires every endpoint, identity and upload setting", () => {
  for (const field of Object.keys(ready).filter((key) => key !== "VITE_ANALYTICS_MODE")) {
    assert.throws(() => releaseAnalyticsEnv({ ...ready, [field]: "" }), new RegExp(field));
  }
  assert.deepEqual(releaseAnalyticsEnv(ready), ready);
});

test("invalid mode and unsafe endpoints fail without echoing configuration", () => {
  assert.throws(() => releaseAnalyticsEnv({ ...ready, VITE_ANALYTICS_MODE: "unexpected" }), /VITE_ANALYTICS_MODE/);
  for (const field of ["VITE_POSTHOG_HOST", "VITE_SENTRY_DSN"]) {
    try {
      releaseAnalyticsEnv({ ...ready, [field]: "http://private-token-sentinel.invalid" });
      assert.fail("insecure endpoint accepted");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(field));
      assert.doesNotMatch(error.message, /private-token-sentinel/);
    }
  }
});

test("the actual wrapper forwards normalized environment to its child", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/ci/analytics-env.ts", process.execPath, "-e", "process.stdout.write(JSON.stringify({mode:process.env.VITE_ANALYTICS_MODE,upload:!!process.env.SENTRY_AUTH_TOKEN,build:process.env.VITE_APP_BUILD}))"], {
    env: { ...process.env, ...ready, VITE_ANALYTICS_MODE: "local" }, encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), { mode: "local", upload: false, build: ready.VITE_APP_BUILD });
});

test("the wrapper preserves child failure and reports only missing setting names", () => {
  const failed = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci/analytics-env.ts", process.execPath, "-e", "process.exit(17)"], { env: { ...process.env, VITE_ANALYTICS_MODE: "local" }, encoding: "utf8" });
  assert.equal(failed.status, 17);
  const invalid = spawnSync(process.execPath, ["--import", "tsx", "scripts/ci/analytics-env.ts", process.execPath, "-e", "process.stdout.write('must-not-run')"], { env: { ...process.env, ...ready, VITE_SENTRY_DSN: "" }, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /VITE_SENTRY_DSN/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-token-sentinel|must-not-run/);
});

