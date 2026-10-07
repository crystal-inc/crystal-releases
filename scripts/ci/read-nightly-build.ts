import { z } from "zod";
import { buildIdSchema, buildRecordSchema } from "../release/channels.ts";

export type JsonRequestOptions = Readonly<{ body?: string; accept?: string }>;

/** A rerun retains the immutable version of its existing release, including drafts. */
export async function readNightlyBuildVersion(
  buildId: string,
  sourceCommit: string,
  json: (path: string, options?: JsonRequestOptions) => Promise<unknown>,
): Promise<string | undefined> {
  const tag = `nightly-${buildIdSchema.parse(buildId)}`;
  const result = z
    .object({
      data: z.object({
        repository: z.object({
          release: z
            .object({ databaseId: z.number().int().positive() })
            .nullable(),
        }),
      }),
    })
    .safeParse(
      await json("graphql", {
        body: JSON.stringify({
          query:
            'query Release($tag: String!) { repository(owner: "crystal-inc", name: "crystal-releases") { release(tagName: $tag) { databaseId } } }',
          variables: { tag },
        }),
      }),
    );
  if (!result.success) throw new Error("Nightly retry lookup is invalid");
  const release = result.data.data.repository.release;
  if (release === null) return undefined;
  const metadata = z
    .object({
      assets: z.array(
        z.object({
          id: z.number().int().positive(),
          name: z.string(),
        }),
      ),
    })
    .safeParse(
      await json(`crystal-inc/crystal-releases/releases/${release.databaseId}`),
    );
  if (!metadata.success) throw new Error("Nightly retry release is invalid");
  const asset = metadata.data.assets.find(
    (asset) => asset.name === "build.json",
  );
  if (!asset)
    throw new Error("Existing nightly has no build metadata; start a new run");
  const build = buildRecordSchema.safeParse(
    await json(`crystal-inc/crystal-releases/releases/assets/${asset.id}`, {
      accept: "application/octet-stream",
    }),
  );
  if (
    !build.success ||
    build.data.buildId !== buildId ||
    build.data.sourceCommit !== sourceCommit
  )
    throw new Error("Nightly retry build identity is invalid");
  return build.data.version;
}
