import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function runPrivateStep(
  script: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), "crystal-log-test-"));
  try {
    await mkdir(join(temporary, "crystal-source"));
    const result = spawnSync(
      "bash",
      [
        fileURLToPath(new URL("../private-step.sh", import.meta.url)),
        "Packaging",
        "bash",
        "-c",
        script,
      ],
      {
        env: { ...process.env, ...environment, RUNNER_TEMP: temporary },
        encoding: "utf8",
      },
    );
    assert.deepEqual(await readdir(temporary), ["crystal-source"]);
    assert.equal(result.stderr, "");
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const started = "Packaging started. Private output is suppressed.\n";
const failed =
  "::error::Packaging failed (exit 7). Reproduce in the private source repository for diagnostics.\n";

test("failed private commands disclose neither source output nor retained log files", async () => {
  const result = await runPrivateStep(
    "echo PRIVATE_SOURCE_STDOUT; echo PRIVATE_SOURCE_STDERR >&2; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, started + failed);
});

test("known native tool failures report only their fixed name and numeric exit status", async () => {
  for (const [tool, code] of [
    ["xcrun", 0],
    ["spctl", 3],
    ["codesign", 1],
    ["/usr/bin/codesign", 1],
    ["/usr/bin/hdiutil", 255],
    ["/usr/bin/ditto", 1],
    ["/usr/bin/tar", 2],
    ["/usr/bin/xattr", 1],
    ["/bin/cp", 1],
    ["minisign", 1],
    ["cargo", 101],
    ["pnpm", 1],
  ] as const) {
    const result = await runPrivateStep(
      `printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' '${tool} exited with status ${code}'; exit 7`,
    );
    assert.equal(result.status, 7);
    assert.equal(
      result.stdout,
      started +
        `::error::Packaging native tool failed: ${tool.split("/").at(-1)} (exit ${code}).\n` +
        failed,
    );
  }
});

test("disk image failures report only allowlisted actions and public reasons", async () => {
  for (const [action, reason] of [
    ["convert", "Resource busy"],
    ["resize", "No space left on device"],
    ["attach", "Operation not permitted"],
    ["detach", "Device not configured"],
    ["verify", "Resource busy"],
  ]) {
    const result = await runPrivateStep(
      `printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' 'hdiutil: ${action} failed - ${reason}'; exit 7`,
    );
    assert.equal(result.status, 7);
    assert.equal(
      result.stdout,
      started +
        `::error::Packaging disk image ${action} failed: ${reason}.\n` +
        failed,
    );
  }
});

test("arbitrary errors, private paths and malformed diagnostic lookalikes stay suppressed", async () => {
  const lines = [
    "PRIVATE_SECRET",
    "/private/source/spctl exited with status 1",
    "curl exited with status 1",
    "xcrun exited with status 256",
    "xcrun exited with status -1",
    "xcrun exited with status 01",
    "xcrun exited with status 1 PRIVATE_SECRET",
    "PRIVATE_SECRET spctl exited with status 1",
    "hdiutil: PRIVATE_SECRET failed - Resource busy",
    "hdiutil: convert failed - PRIVATE_SECRET",
    "hdiutil: convert failed - Resource busy /private/source/file.ts",
    "hdiutil: convert failed - Resource busy::error::PRIVATE_SECRET",
  ];
  const result = await runPrivateStep(
    `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}; exit 7`,
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, started + failed);
});

test("success preserves its original summary and suppresses all private output", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' 'spctl exited with status 3'; exit 0",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, started + "Packaging passed.\n");
});

test("Apple failures report only their finite artifact, operation and exit code", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' 'Apple notarization failed: artifact=dmg operation=staple exit=1'; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(
    result.stdout,
    started +
      "::error::Packaging Apple notarization failed: dmg staple (exit 1).\n" +
      failed,
  );
});

test("malformed Apple failure breadcrumbs remain private", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'Apple notarization failed: artifact=PRIVATE_SECRET operation=staple exit=1' 'Apple notarization failed: artifact=app operation=PRIVATE_SECRET exit=1' 'Apple notarization failed: artifact=app operation=wait exit=256' 'Apple notarization failed: artifact=app operation=wait exit=1 PRIVATE_SECRET'; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(result.stdout, started + failed);
});

test("DMG phase failures expose only a fixed phase while suppressing internal errors", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'PRIVATE_SECRET /private/source' 'DMG operation failed: phase=resize' 'DMG operation failed: phase=build-image' 'DMG operation failed: phase=PRIVATE_SECRET' 'DMG operation failed: phase=detach /private/source'; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(
    result.stdout,
    started +
      "::error::Packaging DMG operation failed: resize.\n::error::Packaging DMG operation failed: build-image.\n" +
      failed,
  );
});

test("release progress exposes only fixed steps and lifecycle states", async () => {
  const result = await runPrivateStep(
    "printf '%s\\n' 'PRIVATE_SECRET' 'Release step: wasm started' 'Release step: wasm finished' 'Release step: app-submit started' 'Release step: app-submit failed'; exit 7",
  );
  assert.equal(result.status, 7);
  assert.equal(
    result.stdout,
    started +
      "Release step: wasm started\nRelease step: wasm finished\nRelease step: app-submit started\nRelease step: app-submit failed\n" +
      failed,
  );
});

test("malformed release progress and injected workflow commands remain private", async () => {
  const lines = [
    "Release step: PRIVATE_SECRET started",
    "Release step: wasm PRIVATE_SECRET",
    "Release step: wasm started PRIVATE_SECRET",
    "PRIVATE_SECRET Release step: wasm started",
    "Release step: wasm started::warning::PRIVATE_SECRET",
    "Release step: wasm started\rPRIVATE_SECRET",
    "Release step: wasm started\u001b[31mPRIVATE_SECRET",
    "Release step: wasm\tstarted",
    "Release step: wasm  started",
    "Release step: wasm started ",
    "::error::PRIVATE_SECRET",
  ];
  const result = await runPrivateStep(
    `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")}; exit 0`,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, started + "Packaging passed.\n");
});

test("release progress is visible before the private command finishes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "crystal-live-log-test-"));
  await mkdir(join(temporary, "crystal-source"));
  const child = spawn(
    "bash",
    [
      fileURLToPath(new URL("../private-step.sh", import.meta.url)),
      "Packaging",
      "bash",
      "-c",
      "printf '%s\\n' 'PRIVATE_SECRET' 'Release step: native-app started'; IFS= read -r release; printf '%s\\n' 'Release step: native-app finished'",
    ],
    { env: { ...process.env, RUNNER_TEMP: temporary } },
  );
  let stdout = "";
  let stderr = "";
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new Error("Release progress was buffered until command completion"),
          ),
        3000,
      );
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        if (stdout.includes("Release step: native-app started\n")) resolve();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.once("error", reject);
    });
    assert.equal(child.exitCode, null);
    assert.equal(stdout.includes("Release step: native-app finished"), false);
  } finally {
    clearTimeout(deadline);
    child.stdin.end("continue\n");
    await closed;
    await rm(temporary, { recursive: true, force: true });
  }
  assert.equal(child.exitCode, 0);
  assert.equal(stderr, "");
  assert.equal(
    stdout,
    started +
      "Release step: native-app started\nRelease step: native-app finished\nPackaging passed.\n",
  );
});

test("private log transport errors cannot disclose paths or arbitrary tool output", async () => {
  const tools = await mkdtemp(join(tmpdir(), "crystal-log-transport-test-"));
  try {
    await writeFile(
      join(tools, "tee"),
      "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' 'PRIVATE_SECRET /private/source/file.ts' >&2\nexit 1\n",
      { mode: 0o700 },
    );
    const result = await runPrivateStep("printf '%s\\n' PRIVATE_SOURCE", {
      PATH: `${tools}:${process.env.PATH}`,
    });
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout,
      started +
        "::error::Packaging failed (exit 1). Reproduce in the private source repository for diagnostics.\n",
    );
  } finally {
    await rm(tools, { recursive: true, force: true });
  }
});
