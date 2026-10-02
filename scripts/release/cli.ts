import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { buildIdSchema } from "./channels.ts";
import { GithubReleaseRepository } from "./githubReleases.ts";
import { promoteBuild, publishNightly } from "./operations.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing release configuration: ${name}`);
  return value;
}

export async function runReleaseCli(args: readonly string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      target: { type: "string" },
      source: { type: "string" },
      build: { type: "string" },
    },
  });
  if (positionals.length !== 1)
    throw new Error("Expected one release command: nightly or promote");
  const repository = new GithubReleaseRepository(env("GH_TOKEN"));
  switch (positionals[0]) {
    case "nightly":
      if (Object.keys(values).length)
        throw new Error(
          "Nightly publication does not accept promotion options",
        );
      await publishNightly(
        {
          buildId: env("GITHUB_RUN_ID"),
          version: env("CRYSTAL_RELEASE_VERSION"),
          sourceCommit: env("CRYSTAL_SOURCE_SHA"),
          actor: env("GITHUB_ACTOR"),
          directory: env("CRYSTAL_ARTIFACTS_DIRECTORY"),
        },
        repository,
      );
      break;
    case "promote": {
      const input = z
        .object({
          target: z.enum(["latest", "stable"]),
          source: z.enum(["latest", "nightly"]).optional(),
          build: buildIdSchema.optional(),
        })
        .parse({ ...values, build: values.build || undefined });
      await promoteBuild(
        {
          target: input.target,
          source: input.source,
          buildId: input.build,
          actor: env("GITHUB_ACTOR"),
        },
        repository,
      );
      break;
    }
    default:
      throw new Error("Unknown release command");
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      "Release channel updated using verified, previously built macOS installers and signed updater archives.\n",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runReleaseCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Release operation failed",
    );
    process.exitCode = 1;
  });
}
