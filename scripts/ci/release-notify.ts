import { setTimeout } from "node:timers/promises";
import { z } from "zod";

/** Called only after promotion has published both assets and the stable pointer. */
export async function notifyStableRelease(
  input: {
    url: string;
    oidcUrl: string;
    oidcToken: string;
    revision: string;
  },
  request: typeof fetch = fetch,
): Promise<void> {
  const audience = new URL(input.url);
  const issuerRequest = new URL(input.oidcUrl);
  if (audience.protocol !== "https:" || issuerRequest.protocol !== "https:")
    throw new Error("Release notification requires HTTPS");
  if (!input.oidcToken) throw new Error("OIDC request credential is missing");
  issuerRequest.searchParams.set("audience", audience.href);
  const issued = await request(issuerRequest, {
    headers: { Authorization: `Bearer ${input.oidcToken}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!issued.ok) throw new Error("Release OIDC request failed");
  const { value } = z
    .object({ value: z.string().min(1) })
    .parse(await issued.json());
  const acknowledged = z.object({ revision: z.literal(input.revision) });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request(audience, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${value}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (response.ok && acknowledged.safeParse(await response.json()).success)
        return;
    } catch {
      // Transport interruptions can retry the idempotent, authoritative refresh.
    }
    if (attempt < 2) await setTimeout(500 * 2 ** attempt);
  }
  throw new Error(
    "Stable notification was not acknowledged at its published revision",
  );
}
