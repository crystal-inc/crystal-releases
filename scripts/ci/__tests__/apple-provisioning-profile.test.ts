import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installAppleProvisioningProfile } from "../apple-provisioning-profile.ts";

test("installs the exact profile privately and exports its path only after validation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  await writeFile(githubEnv, "EXISTING=value\n");
  const bytes = Buffer.from("profile fixture bytes");
  let validated = false;
  await installAppleProvisioningProfile(
    {
      encodedProfile: bytes.toString("base64"),
      directory,
      githubEnv,
    },
    async (path) => {
      assert.deepEqual(await readFile(path), bytes);
      assert.equal(await readFile(githubEnv, "utf8"), "EXISTING=value\n");
      validated = true;
    },
  );
  const path = join(directory, "crystal-signing.provisionprofile");
  assert.equal(validated, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(githubEnv, "utf8"),
    `EXISTING=value\nAPPLE_PROVISIONING_PROFILE=${path}\n`,
  );
});

test("invalid CMS never becomes available to packaging and does not disclose the validator output", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  await writeFile(githubEnv, "EXISTING=value\n");
  await assert.rejects(
    installAppleProvisioningProfile(
      {
        encodedProfile: Buffer.from("PRIVATE_PROFILE_CONTENT").toString(
          "base64",
        ),
        directory,
        githubEnv,
      },
      async () => {
        throw new Error("PRIVATE_PROFILE_CONTENT from security cms");
      },
    ),
    {
      message: "Apple provisioning profile could not be installed or validated",
    },
  );
  await assert.rejects(
    stat(join(directory, "crystal-signing.provisionprofile")),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(githubEnv, "utf8"), "EXISTING=value\n");
});

test("malformed or empty base64 is rejected without staging a profile", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const encodedProfile of ["", " \n", "PRIVATE%%%", "dGVzdA==trailing"]) {
    await assert.rejects(
      installAppleProvisioningProfile(
        {
          encodedProfile,
          directory,
          githubEnv: join(directory, "github-env"),
        },
        async () => {
          assert.fail("malformed data must not reach CMS validation");
        },
      ),
      /must be valid base64/,
    );
  }
  await assert.rejects(
    stat(join(directory, "crystal-signing.provisionprofile")),
    { code: "ENOENT" },
  );
});

test("a wrapped base64 secret is accepted without altering the profile bytes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("profile fixture with line breaks in its base64");
  await installAppleProvisioningProfile(
    {
      encodedProfile: bytes.toString("base64").replace(/(.{8})/gu, "$1\n"),
      directory,
      githubEnv: join(directory, "github-env"),
    },
    async (path) => {
      assert.deepEqual(await readFile(path), bytes);
    },
  );
});

test("an environment export failure removes the staged profile", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    installAppleProvisioningProfile(
      {
        encodedProfile: Buffer.from("profile fixture").toString("base64"),
        directory,
        githubEnv: directory,
      },
      async () => {},
    ),
    /could not be installed or validated/,
  );
  await assert.rejects(
    stat(join(directory, "crystal-signing.provisionprofile")),
    { code: "ENOENT" },
  );
});

test("an existing staging file is neither overwritten nor removed", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "crystal-apple-profile-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "crystal-signing.provisionprofile");
  await writeFile(path, "existing asset");
  await assert.rejects(
    installAppleProvisioningProfile(
      {
        encodedProfile: Buffer.from("new asset").toString("base64"),
        directory,
        githubEnv: join(directory, "github-env"),
      },
      async () => {
        assert.fail("must not validate the existing file");
      },
    ),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(path, "utf8"), "existing asset");
});
