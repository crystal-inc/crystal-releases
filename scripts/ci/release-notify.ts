import { setTimeout } from "node:timers/promises";
import { z } from "zod";

const failureSchema = z
  .object({
    operation: z.enum(["oidc", "notify"]),
    reason: z.enum(["http", "transport", "response", "revision"]),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();
type NotificationFailure = z.infer<typeof failureSchema>;

export class ReleaseNotificationError extends Error {
  constructor(readonly failure: NotificationFailure) {
    super("Release notification failed");
  }
}

export function notificationFailureMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof ReleaseNotificationError)) return undefined;
    const parsed = failureSchema.safeParse(error.failure);
    if (!parsed.success) return undefined;
    const { operation, reason, status } = parsed.data;
    return `Release notification failed: operation=${operation} reason=${reason}${status === undefined ? "" : ` status=${status}`}`;
  } catch {
    return undefined;
  }
}

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
  let issued: Response;
  try {
    issued = await request(issuerRequest, {
      headers: { Authorization: `Bearer ${input.oidcToken}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new ReleaseNotificationError({
      operation: "oidc",
      reason: "transport",
    });
  }
  if (!issued.ok)
    throw new ReleaseNotificationError({
      operation: "oidc",
      reason: "http",
      status: issued.status,
    });
  const token = z
    .object({ value: z.string().min(1) })
    .safeParse(await issued.json().catch(() => undefined));
  if (!token.success)
    throw new ReleaseNotificationError({
      operation: "oidc",
      reason: "response",
    });
  const { value } = token.data;
  const acknowledged = z.object({ revision: z.literal(input.revision) });
  let lastFailure = new ReleaseNotificationError({
    operation: "notify",
    reason: "response",
  });
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
      if (!response.ok) {
        lastFailure = new ReleaseNotificationError({
          operation: "notify",
          reason: "http",
          status: response.status,
        });
      } else {
        const body: unknown = await response.json().catch(() => undefined);
        if (acknowledged.safeParse(body).success) return;
        lastFailure = new ReleaseNotificationError({
          operation: "notify",
          reason: z.object({ revision: z.string() }).safeParse(body).success
            ? "revision"
            : "response",
        });
      }
    } catch {
      // Transport interruptions can retry the idempotent, authoritative refresh.
      lastFailure = new ReleaseNotificationError({
        operation: "notify",
        reason: "transport",
      });
    }
    if (attempt < 2) await setTimeout(500 * 2 ** attempt);
  }
  throw lastFailure;
}
