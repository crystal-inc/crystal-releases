import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cache admission deliberately accepts only the current integrity-only lock
// shape. Fetch runs in a separate directory against the public npm registry;
// file/Git/URL resolutions and patches must never enter this public cache.
export function canCachePublicPnpmPackages(lockfile) {
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

export function dependencyFingerprint(files) {
  const hash = createHash("sha256");
  for (const [name, content] of files)
    hash.update(name).update("\0").update(content).update("\0");
  return hash.digest("hex");
}

async function main() {
  const source = join(process.env.RUNNER_TEMP, "crystal-source");
  const pnpm = await readFile(join(source, "pnpm-lock.yaml"), "utf8");
  const cargoFiles = await Promise.all(
    [
      "apps/native/src-tauri/Cargo.lock",
      "packages/render-core/Cargo.lock",
      "packages/plugins/plugin-runtime-native/Cargo.lock",
    ].map(async (name) => [name, await readFile(join(source, name))]),
  );
  await appendFile(
    process.env.GITHUB_OUTPUT,
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

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error("Dependency cache input preparation failed");
    process.exitCode = 1;
  });
}
