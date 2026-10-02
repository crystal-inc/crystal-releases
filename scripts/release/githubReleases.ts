import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  buildRecordSchema,
  channelRecordSchema,
  buildIdSchema,
  verifyInstaller,
  macosArchitectures,
  type BuildRecord,
  type ChannelRecord,
  type ReleaseChannel,
} from "./channels.ts";
import type { Installers, ReleaseRepository } from "./operations.ts";

const repository = "crystal-inc/crystal-releases";
const repositoryPath = `repos/${repository}`;
const releaseSchema = z.object({
  id: z.number().int().positive(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string(),
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().int().nonnegative(),
      digest: z.string().nullable(),
    }),
  ),
});
const contentSchema = z.object({
  sha: z.string(),
  content: z.string(),
  encoding: z.literal("base64"),
});
const pointerSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["nightly", "latest", "stable"]),
  buildId: buildIdSchema,
  version: z.string(),
  releaseTag: z.string(),
});
const releaseTag = (channel: ReleaseChannel, buildId: string) =>
  `${channel}-${buildIdSchema.parse(buildId)}`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** GitHub-specific transport; promotion rules do not depend on GitHub storage. */
interface GithubReleaseDependencies {
  readonly fetch?: typeof fetch;
  readonly gh?: (args: readonly string[]) => void;
}

export class GithubReleaseRepository implements ReleaseRepository {
  constructor(
    private readonly token: string,
    private readonly dependencies: GithubReleaseDependencies = {},
  ) {}

  private async api(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown | null> {
    const response = await (this.dependencies.fetch ?? fetch)(
      `https://api.github.com/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (method === "GET" && response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Release repository request failed (HTTP ${response.status})`,
      );
    return response.json();
  }

  private async release(tag: string): Promise<unknown | null> {
    // GraphQL finds drafts by tag; the REST tag endpoint only finds published releases.
    const result = z
      .object({
        data: z.object({
          repository: z.object({
            release: z
              .object({
                databaseId: z.number().int().positive(),
                tagName: z.literal(tag),
              })
              .nullable(),
          }),
        }),
      })
      .parse(
        await this.api("graphql", "POST", {
          query:
            'query Release($tag: String!) { repository(owner: "crystal-inc", name: "crystal-releases") { release(tagName: $tag) { databaseId tagName } } }',
          variables: { tag },
        }),
      );
    const release = result.data.repository.release;
    return release === null
      ? null
      : this.api(`${repositoryPath}/releases/${release.databaseId}`);
  }

  private gh(args: readonly string[]): void {
    if (this.dependencies.gh) {
      this.dependencies.gh(args);
      return;
    }
    execFileSync("gh", args, {
      stdio: "inherit",
      env: { ...process.env, GH_TOKEN: this.token },
      timeout: 120_000,
    });
  }

  async current(channel: ReleaseChannel): Promise<string> {
    const content = contentSchema.parse(
      await this.api(
        `${repositoryPath}/contents/channels/${channel}.json?ref=main`,
      ),
    );
    const pointer = pointerSchema.parse(
      JSON.parse(Buffer.from(content.content, "base64").toString("utf8")),
    );
    if (
      pointer.channel !== channel ||
      pointer.releaseTag !== releaseTag(channel, pointer.buildId)
    )
      throw new Error("Current channel pointer has unexpected provenance");
    return pointer.buildId;
  }

  async read(channel: ReleaseChannel, buildId: string) {
    const tag = releaseTag(channel, buildId);
    const release = releaseSchema.parse(await this.release(tag));
    if (
      release.draft ||
      release.tag_name !== tag ||
      release.prerelease !== (channel !== "stable")
    )
      throw new Error(
        "Selected channel release is not published or has unexpected flags",
      );
    const directory = await mkdtemp(join(tmpdir(), "crystal-promotion-"));
    try {
      this.gh([
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        directory,
        "--pattern",
        "build.json",
        "--pattern",
        "channel.json",
      ]);
      const build = buildRecordSchema.parse(
        JSON.parse(await readFile(join(directory, "build.json"), "utf8")),
      );
      const record = channelRecordSchema.parse(
        JSON.parse(await readFile(join(directory, "channel.json"), "utf8")),
      );
      if (
        build.buildId !== buildId ||
        record.buildId !== buildId ||
        record.channel !== channel
      )
        throw new Error(
          "Release metadata does not match the selected channel and build",
        );
      this.gh([
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--dir",
        directory,
        "--pattern",
        build.installers.aarch64.name,
        "--pattern",
        build.installers.x86_64.name,
      ]);
      const [aarch64, x86_64] = await Promise.all([
        readFile(join(directory, build.installers.aarch64.name)),
        readFile(join(directory, build.installers.x86_64.name)),
      ]);
      verifyInstaller(aarch64, build.installers.aarch64);
      verifyInstaller(x86_64, build.installers.x86_64);
      return { build, channel: record, installers: { aarch64, x86_64 } };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async publish(
    build: BuildRecord,
    channel: ChannelRecord,
    installers: Installers,
  ): Promise<void> {
    for (const arch of macosArchitectures)
      verifyInstaller(installers[arch], build.installers[arch]);
    const tag = releaseTag(channel.channel, build.buildId);
    const existing = await this.release(tag);
    if (existing !== null && !releaseSchema.parse(existing).draft) {
      const published = await this.read(channel.channel, build.buildId);
      if (
        json(published.build) !== json(build) ||
        published.channel.sourceChannel !== channel.sourceChannel
      )
        throw new Error(
          "A published release cannot be replaced with different artifacts or provenance",
        );
      await this.point(build, channel);
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "crystal-publication-"));
    try {
      const files = [
        "build.json",
        "channel.json",
        "SHA256SUMS",
        build.installers.aarch64.name,
        build.installers.x86_64.name,
      ];
      for (const arch of macosArchitectures) {
        await writeFile(
          join(directory, build.installers[arch].name),
          installers[arch],
        );
      }
      await writeFile(join(directory, "build.json"), json(build));
      await writeFile(join(directory, "channel.json"), json(channel));
      await writeFile(
        join(directory, "SHA256SUMS"),
        ["aarch64", "x86_64"]
          .map((arch) => {
            const asset =
              arch === "aarch64"
                ? build.installers.aarch64
                : build.installers.x86_64;
            return `${asset.sha256}  ${asset.name}\n`;
          })
          .join(""),
      );
      if (existing === null) {
        this.gh([
          "release",
          "create",
          tag,
          "--repo",
          repository,
          "--target",
          "main",
          "--draft",
          "--latest=false",
          "--title",
          `Crystal ${build.version} · ${channel.channel}`,
          "--notes",
          `Build ${build.buildId}. Channel: ${channel.channel}. Promoted from: ${channel.sourceChannel ?? "main"}.\n\nAd-hoc signed macOS installers; Apple notarization is not configured.`,
        ]);
      }
      const pending = releaseSchema.parse(await this.release(tag));
      if (!pending.draft || pending.tag_name !== tag)
        throw new Error("Expected an unpublished draft");
      const missing: string[] = [];
      for (const name of files) {
        const asset = pending.assets.find(
          (candidate) => candidate.name === name,
        );
        if (!asset) missing.push(join(directory, name));
        else {
          const bytes = await readFile(join(directory, name));
          z.object({
            size: z.literal(bytes.length),
            digest: z.literal(
              `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            ),
          }).parse(asset);
        }
      }
      // Resume interrupted uploads without replacing any asset, even in a draft.
      if (missing.length)
        this.gh(["release", "upload", tag, "--repo", repository, ...missing]);
      const draft = releaseSchema.parse(await this.release(tag));
      if (
        !draft.draft ||
        json(draft.assets.map((asset) => asset.name).sort()) !==
          json([...files].sort())
      )
        throw new Error(
          "Draft does not contain exactly the verified public artifact allowlist",
        );
      for (const name of files) {
        const bytes = await readFile(join(directory, name));
        z.object({
          name: z.literal(name),
          size: z.literal(bytes.length),
          digest: z.literal(
            `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          ),
        }).parse(draft.assets.find((asset) => asset.name === name));
      }
      await this.api(`${repositoryPath}/releases/${draft.id}`, "PATCH", {
        draft: false,
        prerelease: channel.channel !== "stable",
        make_latest: channel.channel === "stable" ? "true" : "false",
      });
      await this.point(build, channel);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async point(
    build: BuildRecord,
    channel: ChannelRecord,
  ): Promise<void> {
    const path = `channels/${channel.channel}.json`;
    const existing = await this.api(
      `${repositoryPath}/contents/${path}?ref=main`,
    );
    const content = existing === null ? null : contentSchema.parse(existing);
    if (content && channel.channel === "nightly") {
      const current = pointerSchema.parse(
        JSON.parse(Buffer.from(content.content, "base64").toString("utf8")),
      );
      // Slow older main builds must not move nightly backwards.
      if (BigInt(current.buildId) > BigInt(build.buildId)) return;
    }
    const pointer = {
      schemaVersion: 1,
      channel: channel.channel,
      buildId: build.buildId,
      version: build.version,
      releaseTag: releaseTag(channel.channel, build.buildId),
    };
    await this.api(`${repositoryPath}/contents/${path}`, "PUT", {
      message: `Point ${channel.channel} at Crystal ${build.version} (build ${build.buildId})`,
      branch: "main",
      content: Buffer.from(json(pointer)).toString("base64"),
      ...(content ? { sha: content.sha } : {}),
    });
  }
}
