import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { buildIdSchema } from "./channels.ts";
import { GithubReleaseRepository } from "./githubReleases.ts";
import {
  promoteBuild,
  publishNightly,
  type ReleaseRepository,
} from "./operations.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing release configuration: ${name}`);
  return value;
}

interface PromotionOptions {
  target: "latest" | "stable";
  source?: "latest" | "nightly";
  build?: string;
}

export function createReleaseCommand(
  repository: () => ReleaseRepository = () =>
    new GithubReleaseRepository(env("GH_TOKEN")),
) {
  const command = new Command("crystal-channels").description(
    "Publish and promote verified Crystal builds",
  );

  command
    .command("nightly")
    .description("Publish the completed main build to nightly")
    .action(() =>
      publishNightly(
        {
          buildId: env("GITHUB_RUN_ID"),
          version: env("CRYSTAL_RELEASE_VERSION"),
          sourceCommit: env("CRYSTAL_SOURCE_SHA"),
          actor: env("GITHUB_ACTOR"),
          directory: env("CRYSTAL_ARTIFACTS_DIRECTORY"),
        },
        repository(),
      ),
    );

  command
    .command("promote")
    .description("Promote an existing build without rebuilding")
    .addOption(
      new Option("--target <channel>", "Destination channel")
        .choices(["latest", "stable"])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option(
        "--source <channel>",
        "Source channel; stable defaults to latest",
      ).choices(["latest", "nightly"]),
    )
    .option(
      "--build <id>",
      "Historical build ID; omit to select the current source build",
    )
    .action((options: PromotionOptions) => {
      const buildId = buildIdSchema
        .optional()
        .parse(options.build || undefined);
      return promoteBuild(
        {
          target: options.target,
          source: options.source,
          buildId,
          actor: env("GITHUB_ACTOR"),
        },
        repository(),
      );
    });

  command.hook("postAction", async () => {
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        "Release channel updated using verified, previously built macOS installers and signed updater archives.\n",
      );
  });
  return command;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await createReleaseCommand()
    .parseAsync()
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Release operation failed",
      );
      process.exitCode = 1;
    });
}
