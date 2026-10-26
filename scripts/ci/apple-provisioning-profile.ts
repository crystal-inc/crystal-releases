import { execFile } from "node:child_process";
import { appendFile, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

async function validateCmsProfile(path: string): Promise<void> {
  // Capture CMS metadata rather than sending its contents to public build logs.
  await promisify(execFile)("/usr/bin/security", ["cms", "-D", "-i", path]);
}

/** Stage a signing asset outside published artifacts and export only its path. */
export async function installAppleProvisioningProfile(
  input: Readonly<{
    encodedProfile: string;
    directory: string;
    githubEnv: string;
  }>,
  validateProfile: (path: string) => Promise<void> = validateCmsProfile,
): Promise<void> {
  const encoded = input.encodedProfile.replace(/\s/gu, "");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded)
    throw new Error("Apple provisioning profile must be valid base64");
  const path = join(
    resolve(input.directory),
    "crystal-signing.provisionprofile",
  );
  if (/[\r\n]/u.test(path))
    throw new Error("Invalid runner temporary directory");
  // Exclusive creation avoids overwriting an existing file or following a link.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await validateProfile(path);
    await appendFile(input.githubEnv, `APPLE_PROVISIONING_PROFILE=${path}\n`);
  } catch {
    await rm(path, { force: true });
    throw new Error(
      "Apple provisioning profile could not be installed or validated",
    );
  } finally {
    await file.close();
  }
}
