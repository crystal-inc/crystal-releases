import { createHash } from "node:crypto";
import {
  buildRecordSchema,
  channelRecordSchema,
  macosArchitectures,
  releaseAssets,
} from "../channels.ts";

export const bytes = Buffer.from("verified installer");
const checksum = createHash("sha256").update(bytes).digest("hex");
const signature = Buffer.from("signature fixture").toString("base64");
export const build = buildRecordSchema.parse({
  schemaVersion: 1,
  buildId: "123",
  version: "0.1.123",
  sourceCommit: "a".repeat(40),
  installers: Object.fromEntries(
    macosArchitectures.map((arch) => [
      arch,
      {
        name: `Crystal_0.1.123_darwin-${arch}.dmg`,
        size: bytes.length,
        sha256: checksum,
      },
    ]),
  ),
  updaters: Object.fromEntries(
    macosArchitectures.map((arch) => [
      arch,
      {
        name: `Crystal_0.1.123_darwin-${arch}.app.tar.gz`,
        size: bytes.length,
        sha256: checksum,
        signature,
      },
    ]),
  ),
});
export const artifacts = Object.fromEntries(
  releaseAssets(build).map((asset) => [
    asset.name,
    asset.name.endsWith(".sig") ? Buffer.from(`${signature}\n`) : bytes,
  ]),
);
export const nightly = channelRecordSchema.parse({
  schemaVersion: 1,
  channel: "nightly",
  buildId: "123",
  sourceChannel: null,
  actor: "builder",
});
