import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRecordSchema,
  channelRecordSchema,
  requirePromotion,
  verifyInstaller,
  promotionSource,
  macosArchitectures,
  type BuildRecord,
  type ChannelRecord,
  type ReleaseChannel,
} from "./channels.ts";

export type Installers = Readonly<Record<"aarch64" | "x86_64", Buffer>>;
export interface ReleaseRepository {
  current(channel: ReleaseChannel): Promise<string>;
  read(
    channel: ReleaseChannel,
    buildId: string,
  ): Promise<
    Readonly<{
      build: unknown;
      channel: unknown;
      installers: Installers;
    }>
  >;
  publish(
    build: BuildRecord,
    channel: ChannelRecord,
    installers: Installers,
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
  for (const arch of macosArchitectures)
    verifyInstaller(
      selected.installers[arch],
      promotion.build.installers[arch],
    );
  await repository.publish(
    promotion.build,
    promotion.channel,
    selected.installers,
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
  const readInstaller = async (arch: "aarch64" | "x86_64") => {
    const name = `Crystal_${input.version}_darwin-${arch}.dmg`;
    const root = join(input.directory, `crystal-macos-${arch}`);
    const bytes = await readFile(join(root, name));
    const sums = await readFile(join(root, "SHA256SUMS"), "utf8");
    const match = /^([a-f0-9]{64})  (.+)\n$/u.exec(sums);
    if (!match || match[2] !== name)
      throw new Error("Installer checksum file is invalid");
    const record = { name, sha256: match[1]!, size: bytes.length };
    verifyInstaller(bytes, record);
    return { bytes, record };
  };
  const [arm, intel] = await Promise.all([
    readInstaller("aarch64"),
    readInstaller("x86_64"),
  ]);
  const build = buildRecordSchema.parse({
    schemaVersion: 1,
    buildId: input.buildId,
    version: input.version,
    sourceCommit: input.sourceCommit,
    installers: { aarch64: arm.record, x86_64: intel.record },
  });
  const channel = channelRecordSchema.parse({
    schemaVersion: 1,
    channel: "nightly",
    buildId: build.buildId,
    sourceChannel: null,
    actor: input.actor,
  });
  await repository.publish(build, channel, {
    aarch64: arm.bytes,
    x86_64: intel.bytes,
  });
}
