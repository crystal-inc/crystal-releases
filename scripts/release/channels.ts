import { createHash } from "node:crypto";
import { z } from "zod";

export const macosArchitectures = ["aarch64", "x86_64"] as const;
export const channelSchema = z.enum(["nightly", "latest", "stable"]);
export type ReleaseChannel = z.infer<typeof channelSchema>;
export const buildIdSchema = z
  .string()
  .max(20)
  .regex(/^[1-9]\d*$/u)
  .refine((value) => value.trim() === value);
export const versionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
  .refine((value) => value.trim() === value);
export const signatureSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (value) => Buffer.from(value, "base64").toString("base64") === value,
    "Updater signature must be canonical base64",
  );
const assetSchema = z
  .object({
    name: z.string().min(1),
    sha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/u),
    size: z.number().int().positive(),
  })
  .strict();

/** This record describes one verified build. Promotions preserve it unchanged. */
export const buildRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    buildId: buildIdSchema,
    version: versionSchema,
    sourceCommit: z
      .string()
      .length(40)
      .regex(/^[a-f0-9]{40}$/u),
    updaters: z
      .object({
        aarch64: assetSchema.extend({ signature: signatureSchema }).strict(),
        x86_64: assetSchema.extend({ signature: signatureSchema }).strict(),
      })
      .strict(),
    installers: z
      .object({
        aarch64: assetSchema,
        x86_64: assetSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((build, context) => {
    for (const arch of macosArchitectures) {
      if (
        build.updaters[arch].name !==
        `Crystal_${build.version}_darwin-${arch}.app.tar.gz`
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Updater does not match its version and architecture",
        });
      if (
        build.installers[arch].name !==
        `Crystal_${build.version}_darwin-${arch}.dmg`
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Installer does not match its version and architecture",
        });
    }
  });
export type BuildRecord = z.infer<typeof buildRecordSchema>;

export const channelRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: channelSchema,
    buildId: buildIdSchema,
    sourceChannel: channelSchema.nullable(),
    actor: z.string().min(1),
  })
  .strict()
  .superRefine((record, context) => {
    let allowed: boolean;
    switch (record.channel) {
      case "nightly":
        allowed = record.sourceChannel === null;
        break;
      case "latest":
        allowed = record.sourceChannel === "nightly";
        break;
      case "stable":
        allowed =
          record.sourceChannel === "latest" ||
          record.sourceChannel === "nightly";
        break;
    }
    if (!allowed)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid channel transition",
      });
  });
export type ChannelRecord = z.infer<typeof channelRecordSchema>;

export function promotionSource(
  target: "latest" | "stable",
  requested?: "latest" | "nightly",
): "latest" | "nightly" {
  switch (target) {
    case "latest":
      if (requested !== undefined && requested !== "nightly")
        throw new Error("Latest must be promoted from nightly");
      return "nightly";
    case "stable":
      return requested ?? "latest";
  }
}

export function requirePromotion(
  input: Readonly<{
    target: "latest" | "stable";
    source?: "latest" | "nightly";
    sourceRecord: unknown;
    build: unknown;
    actor: string;
  }>,
): Readonly<{ build: BuildRecord; channel: ChannelRecord }> {
  const build = buildRecordSchema.parse(input.build);
  const source = channelRecordSchema.parse(input.sourceRecord);
  // The default source is part of the target's policy, not a UI-only default.
  const expectedSource = promotionSource(input.target, input.source);
  if (source.channel !== expectedSource || source.buildId !== build.buildId)
    throw new Error(
      "Selected build does not belong to the selected source channel",
    );
  const channel = channelRecordSchema.parse({
    schemaVersion: 1,
    channel: input.target,
    buildId: build.buildId,
    sourceChannel: expectedSource,
    actor: input.actor,
  });
  return { build, channel };
}

export function verifyAsset(
  bytes: Buffer,
  expected: BuildRecord["installers"]["aarch64"],
): void {
  if (
    bytes.length !== expected.size ||
    createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(
      "Artifact checksum or size does not match the verified build",
    );
}

export type ReleaseArtifacts = Readonly<Record<string, Buffer>>;

/** The allowlist is derived from the verified build, never from directory contents. */
export function releaseAssets(build: BuildRecord) {
  return macosArchitectures.flatMap((arch) => {
    const updater = build.updaters[arch];
    const bytes = Buffer.from(`${updater.signature}\n`);
    return [
      build.installers[arch],
      updater,
      {
        name: `${updater.name}.sig`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  });
}

export function verifyArtifacts(
  build: BuildRecord,
  artifacts: ReleaseArtifacts,
): void {
  const assets = releaseAssets(build);
  if (Object.keys(artifacts).length !== assets.length)
    throw new Error("Release artifacts do not match the build allowlist");
  for (const asset of assets) {
    const bytes = artifacts[asset.name];
    if (!bytes) throw new Error("Release artifact is missing");
    verifyAsset(bytes, asset);
  }
}

export type ReleaseSource = Readonly<{ kind: "static-http"; baseUrl: string }>;
export type InstallationPolicy = Readonly<{ kind: "automatic" }>;

export function createUpdateManifest(
  build: BuildRecord,
  source: ReleaseSource,
) {
  const base = new URL(source.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "Update storage must have an HTTPS base URL without credentials, query or fragment",
    );
  const installationPolicy: InstallationPolicy = { kind: "automatic" };
  return {
    schemaVersion: 1,
    version: build.version,
    installationPolicy,
    platforms: Object.fromEntries(
      macosArchitectures.map((arch) => {
        const updater = build.updaters[arch];
        return [
          `darwin-${arch}`,
          {
            url: new URL(updater.name, `${base.href.replace(/\/$/u, "")}/`)
              .href,
            signature: updater.signature,
            sha256: updater.sha256,
            size: updater.size,
          },
        ];
      }),
    ),
  };
}
