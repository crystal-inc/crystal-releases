import { z } from "zod";
import { versionSchema } from "./channels.ts";

export const versionBumpSchema = z.enum(["patch", "minor", "major"]);
export type VersionBump = z.infer<typeof versionBumpSchema>;

export function bumpVersion(version: string, bump: VersionBump): string {
  const [major, minor, patch] = versionSchema
    .parse(version)
    .split(".")
    .map(BigInt);
  switch (versionBumpSchema.parse(bump)) {
    case "patch":
      return `${major}.${minor}.${patch + 1n}`;
    case "minor":
      return `${major}.${minor + 1n}.0`;
    case "major":
      return `${major + 1n}.0.0`;
  }
}
