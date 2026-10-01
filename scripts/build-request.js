import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function parseBuildRequest(eventName, event, appSlug) {
  let sourceRef;
  let version;
  if (eventName === "workflow_dispatch") {
    sourceRef = event.inputs?.source_ref;
    version = event.inputs?.version;
  } else if (eventName === "repository_dispatch") {
    if (
      !appSlug ||
      event.action !== "crystal-native-build" ||
      event.sender?.type !== "Bot" ||
      event.sender?.login !== `${appSlug}[bot]` ||
      event.client_payload?.source_repository !== "crystal-inc/crystal"
    )
      throw new Error("Build dispatch is not from the configured release App");
    sourceRef = event.client_payload.source_sha;
    version = event.client_payload.version;
    if (
      typeof sourceRef !== "string" ||
      sourceRef.trim() !== sourceRef ||
      !/^[a-f0-9]{40}$/.test(sourceRef)
    )
      throw new Error("Dispatched source must be a complete commit SHA");
  } else {
    throw new Error("Unsupported build event");
  }
  if (
    typeof sourceRef !== "string" ||
    sourceRef.trim() !== sourceRef ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(sourceRef) ||
    sourceRef.includes("..") ||
    sourceRef.includes("//")
  )
    throw new Error("Invalid source reference");
  if (
    typeof version !== "string" ||
    version.trim() !== version ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
  )
    throw new Error("Version must be a stable SemVer without v");
  return { sourceRef, version };
}

export async function resolveBuildRequest(
  request,
  token,
  requestFetch = fetch,
) {
  if (!token) throw new Error("Source token is missing");
  const get = async (path) => {
    const response = await requestFetch(
      `https://api.github.com/repos/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new Error(`Private source access failed (HTTP ${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error("Private source API response is invalid");
    }
  };
  const source = await get(
    `crystal-inc/crystal/commits/${encodeURIComponent(request.sourceRef)}`,
  );
  if (
    typeof source.sha !== "string" ||
    source.sha.trim() !== source.sha ||
    !/^[a-f0-9]{40}$/.test(source.sha)
  )
    throw new Error("Source did not resolve to a complete commit SHA");
  const helper = await get(
    `crystal-inc/crystal/contents/.private/crystal-server?ref=${source.sha}`,
  );
  if (
    ![
      "git@github.com:crystal-inc/crystal-server.git",
      "https://github.com/crystal-inc/crystal-server.git",
    ].includes(helper.submodule_git_url) ||
    typeof helper.sha !== "string" ||
    helper.sha.trim() !== helper.sha ||
    !/^[a-f0-9]{40}$/.test(helper.sha)
  )
    throw new Error("Source has an unexpected helper submodule");
  const helperCommit = await get(
    `crystal-inc/crystal-server/commits/${helper.sha}`,
  );
  if (helperCommit.sha !== helper.sha)
    throw new Error("Pinned helper commit is unavailable");
  return { commit: source.sha, version: request.version };
}

async function main() {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const request = parseBuildRequest(
    process.env.GITHUB_EVENT_NAME,
    event,
    process.env.RELEASE_APP_SLUG,
  );
  const build = await resolveBuildRequest(
    request,
    process.env.SOURCE_READ_TOKEN,
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `commit=${build.commit}\nversion=${build.version}\n`,
  );
  console.log("Source commit and pinned helper access verified.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // API response bodies and private commit messages must never reach public logs.
    console.error(
      error instanceof Error
        ? error.message
        : "Build request validation failed",
    );
    process.exitCode = 1;
  });
}
