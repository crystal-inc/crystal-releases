import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { notifyStableRelease } from "./release-notify.ts";
import {
  readNightlyBuildVersion,
  type JsonRequestOptions,
} from "./read-nightly-build.ts";
import {
  bumpVersion,
  versionBumpSchema,
  type VersionBump,
} from "../release/versions.ts";
import { versionSchema, signatureSchema } from "../release/channels.ts";

const commitSchema = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/u);
const sourceRefSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u)
  .refine(
    (value) =>
      value.trim() === value && !value.includes("..") && !value.includes("//"),
  );

type BuildRequest = Readonly<{ sourceRef: string }> &
  (
    | Readonly<{ kind: "test"; version: string }>
    | Readonly<{ kind: "nightly"; bump: VersionBump }>
  );

const dispatchSourceSchema = z.object({
  source_repository: z.literal("crystal-inc/crystal"),
  source_sha: commitSchema,
});

export function parseBuildRequest(
  eventName: string,
  event: unknown,
  appSlug?: string,
): BuildRequest {
  switch (eventName) {
    case "workflow_dispatch": {
      const result = z
        .object({
          inputs: z.object({
            source_ref: sourceRefSchema,
            version: versionSchema,
          }),
        })
        .safeParse(event);
      if (!result.success) throw new Error("Invalid manual build request");
      return {
        sourceRef: result.data.inputs.source_ref,
        version: result.data.inputs.version,
        kind: "test",
      };
    }
    case "repository_dispatch": {
      if (!appSlug) throw new Error("Release App is missing");
      const result = z
        .object({
          action: z.literal("crystal-native-build"),
          sender: z.object({
            type: z.literal("Bot"),
            login: z.literal(`${appSlug}[bot]`),
          }),
          client_payload: z.discriminatedUnion("build_kind", [
            dispatchSourceSchema.extend({
              build_kind: z.literal("nightly"),
              bump: versionBumpSchema.default("patch"),
            }),
            dispatchSourceSchema.extend({
              build_kind: z.literal("test"),
              version: versionSchema,
            }),
          ]),
        })
        .safeParse(event);
      if (!result.success)
        throw new Error(
          "Build dispatch is not a valid request from the configured release App",
        );
      const payload = result.data.client_payload;
      const sourceRef = payload.source_sha;
      return payload.build_kind === "nightly"
        ? { sourceRef, kind: "nightly", bump: payload.bump }
        : { sourceRef, kind: "test", version: payload.version };
    }
    default:
      throw new Error("Unsupported build event");
  }
}

type RequestFetch = (
  url: string,
  options: {
    headers: Record<string, string>;
    signal: AbortSignal;
    method?: string;
    body?: string;
  },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

export async function resolveBuildRequest(
  request: BuildRequest,
  token: string,
  requestFetch: RequestFetch = fetch,
  channelReadToken?: string,
  rerunBuildId?: string,
) {
  if (!token) throw new Error("Source token is missing");
  const get = async (
    path: string,
    accessToken = token,
    context = "Private source",
    options: JsonRequestOptions = {},
  ): Promise<unknown> => {
    const response = await requestFetch(
      path === "graphql"
        ? "https://api.github.com/graphql"
        : `https://api.github.com/repos/${path}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: options.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { method: "POST", body: options.body } : {}),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`${context} access failed (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${context} API response is invalid`);
    }
  };
  const source = z
    .object({ sha: commitSchema })
    .safeParse(
      await get(
        `crystal-inc/crystal/commits/${encodeURIComponent(request.sourceRef)}`,
      ),
    );
  if (!source.success)
    throw new Error("Source did not resolve to a complete commit SHA");
  const helper = z
    .object({
      sha: commitSchema,
      submodule_git_url: z.enum([
        "git@github.com:crystal-inc/crystal-server.git",
        "https://github.com/crystal-inc/crystal-server.git",
      ]),
    })
    .safeParse(
      await get(
        `crystal-inc/crystal/contents/.private/crystal-server?ref=${source.data.sha}`,
      ),
    );
  if (!helper.success)
    throw new Error("Source has an unexpected helper submodule");
  const helperCommit = z
    .object({ sha: z.literal(helper.data.sha) })
    .safeParse(
      await get(`crystal-inc/crystal-server/commits/${helper.data.sha}`),
    );
  if (!helperCommit.success)
    throw new Error("Pinned helper commit is unavailable");
  let version: string;
  if (request.kind === "nightly") {
    if (!channelReadToken) throw new Error("Nightly channel token is missing");
    if (rerunBuildId) {
      const previousVersion = await readNightlyBuildVersion(
        rerunBuildId,
        source.data.sha,
        (path, options) =>
          get(path, channelReadToken, "Nightly retry", options),
      );
      if (previousVersion)
        return {
          commit: source.data.sha,
          version: previousVersion,
          kind: request.kind,
        };
    }
    const configFile = z
      .object({ encoding: z.literal("base64"), content: z.string() })
      .safeParse(
        await get(
          "crystal-inc/crystal-releases/contents/channels/nightly.json?ref=main",
          channelReadToken,
          "Nightly channel",
        ),
      );
    if (!configFile.success)
      throw new Error("Published nightly version is unavailable");
    let config: unknown;
    try {
      config = JSON.parse(
        Buffer.from(configFile.data.content, "base64").toString("utf8"),
      );
    } catch {
      throw new Error("Published nightly version is invalid");
    }
    const base = z
      .object({
        schemaVersion: z.literal(1),
        channel: z.literal("nightly"),
        version: versionSchema,
      })
      .safeParse(config);
    if (!base.success) throw new Error("Published nightly version is invalid");
    version = bumpVersion(base.data.version, request.bump);
  } else {
    version = request.version;
  }
  return { commit: source.data.sha, version, kind: request.kind };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing CI configuration: ${name}`);
  return value;
}

async function prepareBuildRequest(): Promise<void> {
  const event: unknown = JSON.parse(
    await readFile(requiredEnv("GITHUB_EVENT_PATH"), "utf8"),
  );
  const request = parseBuildRequest(
    requiredEnv("GITHUB_EVENT_NAME"),
    event,
    process.env.RELEASE_APP_SLUG,
  );
  const build = await resolveBuildRequest(
    request,
    requiredEnv("SOURCE_READ_TOKEN"),
    fetch,
    process.env.CHANNEL_READ_TOKEN,
    Number(process.env.GITHUB_RUN_ATTEMPT) > 1
      ? requiredEnv("GITHUB_RUN_ID")
      : undefined,
  );
  await appendFile(
    requiredEnv("GITHUB_OUTPUT"),
    `commit=${build.commit}\nversion=${build.version}\nkind=${build.kind}\n`,
  );
  if (request.kind === "nightly") {
    await appendFile(
      requiredEnv("GITHUB_STEP_SUMMARY"),
      `Nightly version: **${build.version}**. Requested bump: **${request.bump}**.\n`,
    );
  }
  console.log("Source commit and pinned helper access verified.");
}

// Fail closed: only integrity-only public registry resolutions enter the cache.
// Fetch happens away from private source; file/Git/URL packages and patches are excluded.
export function canCachePublicPnpmPackages(lockfile: string): boolean {
  const packages = lockfile
    .split(/^packages:\s*$/m)[1]
    ?.split(/^snapshots:\s*$/m)[0];
  if (!packages || /^patchedDependencies:/m.test(lockfile)) return false;
  const entries = packages.match(/^  \S.*:\s*$/gm) ?? [];
  const resolutions = packages.match(/^    resolution:.*$/gm) ?? [];
  return (
    resolutions.length > 0 &&
    resolutions.length === entries.length &&
    resolutions.every((line) =>
      /^    resolution: \{integrity: sha(?:512|256|1)-[A-Za-z0-9+/=]+\}$/.test(
        line,
      ),
    ) &&
    entries.every((line) => !/(?:file:|link:|git\+|https?:\/\/)/.test(line))
  );
}

export function dependencyFingerprint(
  files: readonly (readonly [string, string | Buffer])[],
): string {
  const hash = createHash("sha256");
  for (const [name, content] of files)
    hash.update(name).update("\0").update(content).update("\0");
  return hash.digest("hex");
}

async function prepareCacheInputs(): Promise<void> {
  const source = join(requiredEnv("RUNNER_TEMP"), "crystal-source");
  const pnpm = await readFile(join(source, "pnpm-lock.yaml"), "utf8");
  const cargoFiles = await Promise.all(
    [
      "apps/native/src-tauri/Cargo.lock",
      "packages/render-core/Cargo.lock",
      "packages/plugins/plugin-runtime-native/Cargo.lock",
    ].map(
      async (name): Promise<[string, Buffer]> => [
        name,
        await readFile(join(source, name)),
      ],
    ),
  );
  await appendFile(
    requiredEnv("GITHUB_OUTPUT"),
    [
      `pnpm_key=${dependencyFingerprint([["pnpm-lock.yaml", pnpm]])}`,
      `pnpm_public=${canCachePublicPnpmPackages(pnpm)}`,
      `cargo_key=${dependencyFingerprint(cargoFiles)}`,
      "",
    ].join("\n"),
  );
  console.log(
    "Dependency fingerprints prepared; only registry packages are eligible for public caching.",
  );
}

async function prepareArtifacts(): Promise<void> {
  const result = z
    .object({
      CRYSTAL_RELEASE_VERSION: versionSchema,
      CRYSTAL_SOURCE_SHA: commitSchema,
      CRYSTAL_BUILD_ARCH: z.enum(["aarch64", "x86_64"]),
      RUNNER_TEMP: z.string().min(1),
    })
    .safeParse(process.env);
  if (!result.success) throw new Error("Artifact configuration is invalid");
  const {
    CRYSTAL_RELEASE_VERSION: version,
    CRYSTAL_SOURCE_SHA: commit,
    CRYSTAL_BUILD_ARCH: arch,
    RUNNER_TEMP: temporary,
  } = result.data;
  const source = join(temporary, "crystal-release");
  const destination = join(temporary, "crystal-public-artifacts");
  const metadata: unknown = JSON.parse(
    await readFile(join(source, `build-${arch}.json`), "utf8"),
  );
  const build = z
    .object({
      version: z.literal(version),
      architecture: z.literal(arch),
      commit: z.literal(commit),
      appSigning: z.literal("adhoc"),
      updaterSigning: z.literal("signed"),
    })
    .safeParse(metadata);
  if (!build.success)
    throw new Error("Artifact metadata does not match the requested build");
  const stem = `Crystal_${version}_darwin-${arch}`;
  const readArtifact = async (name: string) => ({
    name,
    bytes: await readFile(join(source, name)),
  });
  const [installer, updater, signatureFile] = await Promise.all([
    readArtifact(`${stem}.dmg`),
    readArtifact(`${stem}.app.tar.gz`),
    readArtifact(`${stem}.app.tar.gz.sig`),
  ]);
  const files = [installer, updater, signatureFile];
  if (files.some((file) => !file.bytes.length))
    throw new Error("Release artifact is empty");
  const signature = signatureSchema.parse(
    signatureFile.bytes.toString("utf8").trim(),
  );
  signatureFile.bytes = Buffer.from(`${signature}\n`);
  // Never carry over files from a previous invocation into the upload directory.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of files)
    await writeFile(join(destination, file.name), file.bytes);
  await writeFile(
    join(destination, "SHA256SUMS"),
    files
      .map(
        (file) =>
          `${createHash("sha256").update(file.bytes).digest("hex")}  ${file.name}\n`,
      )
      .join(""),
  );
  console.log(
    "Installer, authenticated updater and checksum allowlist prepared.",
  );
}

async function prepareReleaseNotification(): Promise<void> {
  const bytes = await readFile("channels/stable.json");
  const revision = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  await notifyStableRelease({
    url: process.env.CRYSTAL_RELEASE_NOTIFY_URL ?? "",
    oidcUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
    oidcToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
    revision,
  });
  console.log(
    "Stable publication acknowledged; connected apps can check the signed update.",
  );
}

export async function runCiCli(args: readonly string[]): Promise<void> {
  if (args.length !== 1)
    throw new Error(
      "Expected one CI command: request, cache, artifacts or notify-release",
    );
  switch (args[0]) {
    case "request":
      return prepareBuildRequest();
    case "cache":
      return prepareCacheInputs();
    case "notify-release":
      return prepareReleaseNotification();
    case "artifacts":
      return prepareArtifacts();
    default:
      throw new Error("Unknown CI command");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCiCli(process.argv.slice(2)).catch(() => {
    // Neither response bodies nor unexpected errors from private source reach public logs.
    console.error(
      "CI preparation failed; verify the command, configuration and source access.",
    );
    process.exitCode = 1;
  });
}
