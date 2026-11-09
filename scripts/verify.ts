import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");
// A wedged step must fail loudly instead of holding a CI job for hours: bun 1.4.x can lose
// pipe events on Windows and hang an untimed await forever (oven-sh/bun#45473), which
// defeats both the test timeouts and any await inside the wedged process itself. The
// watchdog lives in this parent process, so it still fires when the child is stuck.
const STEP_WATCHDOG_MS = 20 * 60_000;
const TAIL_LINES = 60;

function escapeWorkflowData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function reportStepFailure(title: string, tail: string[]): void {
  const body = tail.join("\n") || "(no output captured)";
  if (process.env.GITHUB_ACTIONS === "true") {
    // Annotations are the only failure evidence readable without repository log access.
    console.log(`::error title=${escapeWorkflowData(title)}::${escapeWorkflowData(body)}`);
  } else {
    console.error(`${title}\n${body}`);
  }
}

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const tail: string[] = [];
  const pump = (stream: ReadableStream<Uint8Array>, sink: { write(chunk: string): unknown }) => (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = carry + decoder.decode(value, { stream: true });
        const lines = text.split(/\r?\n/);
        carry = lines.pop() ?? "";
        if (lines.length > 0) sink.write(`${lines.join("\n")}\n`);
        for (const line of lines) {
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      }
      if (carry) {
        sink.write(carry);
        tail.push(carry);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    } catch {
      // The stream ends with the child; a teardown race must not mask the exit code.
    }
  })();
  const stdoutPump = pump(child.stdout, process.stdout);
  const stderrPump = pump(child.stderr, process.stderr);
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, STEP_WATCHDOG_MS);
  const exitCode = await child.exited;
  clearTimeout(watchdog);
  // Orphaned grandchildren can hold the inherited pipes open after the child exits;
  // drain what is available and move on instead of waiting on them forever.
  await Promise.race([
    Promise.all([stdoutPump, stderrPump]),
    new Promise<void>(resolveRace => setTimeout(resolveRace, 2_000)),
  ]);
  const label = `bun ${args.join(" ")}`;
  if (timedOut) {
    reportStepFailure(`verify step exceeded ${STEP_WATCHDOG_MS / 60_000} minutes: ${label}`, tail);
    throw new Error(`Verification command timed out (${STEP_WATCHDOG_MS / 60_000} minutes): ${label}`);
  }
  if (exitCode !== 0) {
    reportStepFailure(`verify step failed (exit ${exitCode}): ${label}`, tail);
    throw new Error(`Verification command failed (${exitCode}): ${label}`);
  }
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  // Electron now downloads its executable on first use. Do this before timed tests.
  await run(["run", "launcher/node_modules/electron/install.js"]);
  await run(["run", "typecheck"]);
  await run(["run", "test"]);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "--cwd", "launcher", "build:renderer"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
