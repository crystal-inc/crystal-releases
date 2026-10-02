import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRecordSchema,
  channelRecordSchema,
  requirePromotion,
  promotionSource,
  versionSchema,
  signatureSchema,
  verifyAsset,
  verifyArtifacts,
  type BuildRecord,
  type ChannelRecord,
  type ReleaseChannel,
  type ReleaseArtifacts,
} from "./channels.ts";

export interface ReleaseRepository {
  current(channel: ReleaseChannel): Promise<string>;
  read(
    channel: ReleaseChannel,
    buildId: string,
  ): Promise<
    Readonly<{
      build: unknown;
      channel: unknown;
      artifacts: ReleaseArtifacts;
    }>
  >;
  publish(
    build: BuildRecord,
    channel: ChannelRecord,
    artifacts: ReleaseArtifacts,
  ): Promise<void>;
}

/** Both normal and direct stable promotion use the same artifact verification. */
export async function promoteBuild(
  input: Readonly<{
    target: "latest" | "stable";
    source?: "nightly" | "latest";
    buildId?: string;
    actor: string;
  }>,
  repository: ReleaseRepository,
): Promise<void> {
  const source = promotionSource(input.target, input.source);
  const buildId = input.buildId ?? (await repository.current(source));
  const selected = await repository.read(source, buildId);
  const promotion = requirePromotion({
    target: input.target,
    source,
    sourceRecord: selected.channel,
    build: selected.build,
    actor: input.actor,
  });
  if (promotion.build.buildId !== buildId)
    throw new Error("Repository returned a different build");
  verifyArtifacts(promotion.build, selected.artifacts);
  await repository.publish(
    promotion.build,
    promotion.channel,
    selected.artifacts,
  );
}

export async function publishNightly(
  input: Readonly<{
    buildId: string;
    version: string;
    sourceCommit: string;
    actor: string;
    directory: string;
  }>,
  repository: ReleaseRepository,
): Promise<void> {
  const version = versionSchema.parse(input.version);
  const readArchitecture = async (arch: "aarch64" | "x86_64") => {
    const stem = `Crystal_${version}_darwin-${arch}`;
    const installerName = `${stem}.dmg`;
    const updaterName = `${stem}.app.tar.gz`;
    const names = [installerName, updaterName, `${updaterName}.sig`];
    const directory = join(input.directory, `crystal-macos-${arch}`);
    const sums = new Map<string, string>();
    for (const line of (await readFile(join(directory, "SHA256SUMS"), "utf8"))
      .trimEnd()
      .split("\n")) {
      const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
      const [, digest, name] = match ?? [];
      if (!digest || !name || !names.includes(name) || sums.has(name))
        throw new Error("Artifact checksum file is invalid");
      sums.set(name, digest);
    }
    if (sums.size !== names.length)
      throw new Error("Artifact checksum file is incomplete");
    const readArtifact = async (name: string) => {
      const bytes = await readFile(join(directory, name));
      const sha256 = sums.get(name);
      if (!sha256) throw new Error("Release artifact checksum is missing");
      const asset = { name, size: bytes.length, sha256 };
      verifyAsset(bytes, asset);
      return { asset, bytes };
    };
    const [installer, updater, signature] = await Promise.all([
      readArtifact(installerName),
      readArtifact(updaterName),
      readArtifact(`${updaterName}.sig`),
    ]);
    return {
      installer: installer.asset,
      updater: {
        ...updater.asset,
        signature: signatureSchema.parse(
          signature.bytes.toString("utf8").trim(),
        ),
      },
      artifacts: Object.fromEntries(
        [installer, updater, signature].map((file) => [
          file.asset.name,
          file.bytes,
        ]),
      ),
    };
  };
  const [arm, intel] = await Promise.all([
    readArchitecture("aarch64"),
    readArchitecture("x86_64"),
  ]);
  const build = buildRecordSchema.parse({
    schemaVersion: 1,
    buildId: input.buildId,
    version,
    sourceCommit: input.sourceCommit,
    installers: { aarch64: arm.installer, x86_64: intel.installer },
    updaters: { aarch64: arm.updater, x86_64: intel.updater },
  });
  const channel = channelRecordSchema.parse({
    schemaVersion: 1,
    channel: "nightly",
    buildId: build.buildId,
    sourceChannel: null,
    actor: input.actor,
  });
  const artifacts = { ...arm.artifacts, ...intel.artifacts };
  verifyArtifacts(build, artifacts);
  await repository.publish(build, channel, artifacts);
}
