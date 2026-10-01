import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const {
  CRYSTAL_RELEASE_VERSION: version,
  CRYSTAL_SOURCE_SHA: commit,
  CRYSTAL_BUILD_ARCH: arch,
  RUNNER_TEMP: temporary,
} = process.env;
if (
  !version ||
  version.trim() !== version ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
  !/^[a-f0-9]{40}$/.test(commit ?? "") ||
  !["aarch64", "x86_64"].includes(arch) ||
  !temporary
)
  throw new Error("Artifact configuration is invalid");
const source = join(temporary, "crystal-release");
const destination = join(temporary, "crystal-public-artifacts");
const metadata = JSON.parse(
  await readFile(join(source, `build-${arch}.json`), "utf8"),
);
if (
  metadata.version !== version ||
  metadata.architecture !== arch ||
  metadata.commit !== commit ||
  metadata.signed !== false
)
  throw new Error("Artifact metadata does not match the requested build");
const installer = `Crystal_${version}_darwin-${arch}.dmg`;
const bytes = await readFile(join(source, installer));
if (!bytes.length) throw new Error("Installer is empty");
await mkdir(destination, { recursive: true });
await copyFile(join(source, installer), join(destination, installer));
await writeFile(
  join(destination, "SHA256SUMS"),
  `${createHash("sha256").update(bytes).digest("hex")}  ${installer}\n`,
);
console.log("DMG and checksum allowlist prepared.");
