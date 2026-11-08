import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Environment = Readonly<Record<string, string | undefined>>;
const optional = [
  "VITE_POSTHOG_KEY", "VITE_POSTHOG_HOST", "VITE_SENTRY_DSN", "VITE_APP_BUILD",
  "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT",
] as const;

/** One environment for Vite, Cargo and symbol upload; local builds stay offline. */
export function releaseAnalyticsEnv(input: Environment): Record<string, string | undefined> {
  const env = { ...input };
  const mode = env.VITE_ANALYTICS_MODE || "local";
  if (mode !== "local" && mode !== "remote")
    throw new Error("Invalid VITE_ANALYTICS_MODE; expected local or remote");
  env.VITE_ANALYTICS_MODE = mode;
  const reports = env.AGENT_ACTIVITY_REPORTS_ENABLED || "false";
  if (reports !== "true" && reports !== "false")
    throw new Error("Invalid AGENT_ACTIVITY_REPORTS_ENABLED; expected true or false");
  env.AGENT_ACTIVITY_REPORTS_ENABLED = reports;
  for (const key of optional) if (!env[key]?.trim()) delete env[key];
  if (mode === "local") {
    delete env.SENTRY_AUTH_TOKEN;
    return env;
  }
  for (const key of optional)
    if (!env[key]) throw new Error(`Missing remote analytics setting: ${key}`);
  for (const key of ["VITE_POSTHOG_HOST", "VITE_SENTRY_DSN"] as const) {
    try {
      if (new URL(env[key]!).protocol !== "https:") throw new Error();
    } catch {
      throw new Error(`Invalid HTTPS analytics endpoint: ${key}`);
    }
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command) throw new Error("An analytics build command is required");
    const child = spawnSync(command, args, { env: releaseAnalyticsEnv(process.env), stdio: "inherit" });
    if (child.error) throw new Error("Unable to start the analytics build command");
    process.exitCode = child.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Analytics build configuration failed");
    process.exitCode = 1;
  }
}
