/**
 * Upstream Codex installs its provider into Codex's own configuration and
 * trusts native rollout identity. OpenCode needs a distinct, isolated provider
 * catalog and V2 identity plugin; these tests ensure provisioning and key
 * delivery cannot alter the user's existing host OpenCode configuration.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import {
  openCodeDevHostEnvironment,
  openCodeDevHostPaths,
  openCodeListenerRunning,
  prepareOpenCodeDevHost,
  readOpenCodeDevHostKey,
  readOpenCodeDevHostPort,
  readOpenCodeDevHostStatus,
  runOpenCodeDevHost,
} from "../src/opencode/dev-host";
import { OPENCODE_WEBSITE_CONNECTOR_DEV_NAME } from "../src/opencode/website-connector";

function fixture({ solAvailable = true, proAvailable = false, extraHighAvailable = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "opencode-dev-host-"));
  const config = {
    ...defaultConfig("full"),
    purpose: "dev-harness" as const,
    browserInteractionMode: "automatic" as const,
    websiteMcpContract: "opencode" as const,
    appName: OPENCODE_WEBSITE_CONNECTOR_DEV_NAME,
    automaticAppName: OPENCODE_WEBSITE_CONNECTOR_DEV_NAME,
    browserHost: "launcher" as const,
    browserHostDescriptorPath: join(home, "runtime", "launcher-browser.json"),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    solAvailable, proAvailable, extraHighAvailable,
  };
  return { home, config, clean: () => rmSync(home, { force: true, recursive: true }) };
}

describe("isolated OpenCode DEV host preparation", () => {
  test("creates a private provider, plugin and stable signing key without leaking inherited OpenCode settings", () => {
    const f = fixture();
    try {
      const prepared = prepareOpenCodeDevHost(f.home, f.config);
      const key = readOpenCodeDevHostKey(prepared).toString("hex");
      expect(key).toMatch(/^[a-f0-9]{64}$/);
      expect(readOpenCodeDevHostPort(prepared)).toBe(17843);
      expect(readFileSync(prepared.pluginFile, "utf8")).toContain("Upstream OpenCode");
      expect(readFileSync(prepared.pluginFile, "utf8")).toContain("createOpenCodeIdentityPlugin()");
      expect(JSON.parse(readFileSync(prepared.configFile, "utf8")).model).toBe("opencode-chatgpt-web/gpt-6-sol");
      const models = JSON.parse(readFileSync(prepared.configFile, "utf8")).providers["opencode-chatgpt-web"].models;
      expect(models["gpt-6-sol"].modelID).toBe("opencode-chatgpt-web/gpt-6-sol");
      expect(models["gpt-6-sol"].capabilities.tools).toBe(true);
      expect(models["gpt-5.6-pro"]).toBeUndefined();
      expect(models["gpt-6-pro"]).toBeUndefined();
      expect(openCodeDevHostPaths(f.home)).toEqual(prepared);
      expect(prepareOpenCodeDevHost(f.home, f.config)).toEqual(prepared);
      expect(readOpenCodeDevHostKey(prepared).toString("hex")).toBe(key);
      // win32 does not enforce POSIX modes (lstat reports fabricated bits).
      if (process.platform !== "win32") for (const path of [prepared.root, prepared.home, prepared.configRoot, prepared.dataRoot, prepared.cacheRoot, prepared.stateRoot]) {
        expect(lstatSync(path).mode & 0o077).toBe(0);
      }
      if (process.platform !== "win32") for (const path of [prepared.configFile, prepared.pluginFile, prepared.signingKeyFile]) {
        expect(lstatSync(path).mode & 0o077).toBe(0);
      }
      const env = openCodeDevHostEnvironment(prepared, {
        HOME: "/original-home", XDG_CONFIG_HOME: "/original-config", CODEX_HOME: "/original-codex",
        OPENCODE_CONFIG: "/original-opencode.json", OPENCODE_CHATGPT_WEB_TURN_KEY: "old-value",
        PATH: "/usr/bin",
      });
      expect(env.HOME).toBe(prepared.home);
      expect(env.XDG_CONFIG_HOME).toBe(prepared.configRoot);
      expect(env.XDG_DATA_HOME).toBe(prepared.dataRoot);
      expect(env.XDG_CACHE_HOME).toBe(prepared.cacheRoot);
      expect(env.XDG_STATE_HOME).toBe(prepared.stateRoot);
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.OPENCODE_CONFIG).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
      expect(env.OPENCODE_CHATGPT_WEB_TURN_KEY).toBe(key);
      expect(env.OPENCODE_CHATGPT_WEB_BRIDGE_URL).toBe("http://127.0.0.1:17843");
    } finally { f.clean(); }
  });

  test("filters models to account capabilities and rejects invalid listener setups before writing", () => {
    const f = fixture({ solAvailable: false });
    try {
      const paths = prepareOpenCodeDevHost(f.home, f.config, { port: 17997 });
      expect(readOpenCodeDevHostPort(paths)).toBe(17997);
      const config = JSON.parse(readFileSync(paths.configFile, "utf8"));
      expect(config.model).toMatch(/^opencode-chatgpt-web\//);
      expect(Object.keys(config.providers["opencode-chatgpt-web"].models).every(name => !name.includes("sol"))).toBe(true);
      expect(() => prepareOpenCodeDevHost(f.home, f.config, { port: 17841 })).toThrow("separate loopback");
      expect(() => prepareOpenCodeDevHost(f.home, { ...f.config, websiteMcpContract: undefined })).toThrow("automatic Full Harness");
    } finally { f.clean(); }
  });

  test("rejects edits, insecure files, symlinked state, changed ports and silent key rotation", () => {
    const f = fixture();
    try {
      const paths = prepareOpenCodeDevHost(f.home, f.config);
      const key = readOpenCodeDevHostKey(paths).toString("hex");
      expect(() => prepareOpenCodeDevHost(f.home, f.config, { port: 17842 })).toThrow("overwrite");
      expect(readOpenCodeDevHostKey(paths).toString("hex")).toBe(key);
      writeFileSync(paths.configFile, "{\"userEdited\":true}\n");
      expect(() => prepareOpenCodeDevHost(f.home, f.config)).toThrow("overwrite");
      expect(readFileSync(paths.configFile, "utf8")).toContain("userEdited");
      expect(() => readOpenCodeDevHostPort(paths)).toThrow("provider URL is missing");
      writeFileSync(paths.configFile, "null\n");
      expect(() => readOpenCodeDevHostPort(paths)).toThrow("provider URL is missing");
      writeFileSync(paths.configFile, '{"providers":{"opencode-chatgpt-web":{"settings":{"baseURL":"not-a-url"}}}}\n');
      expect(() => readOpenCodeDevHostPort(paths)).toThrow("provider URL is invalid");
      if (process.platform !== "win32") {
        chmodSync(paths.configFile, 0o644);
        expect(() => prepareOpenCodeDevHost(f.home, f.config)).toThrow("private");
        chmodSync(paths.configFile, 0o600);
      }
      rmSync(paths.signingKeyFile);
      symlinkSync(paths.configFile, paths.signingKeyFile);
      expect(() => readOpenCodeDevHostKey(paths)).toThrow("non-symlink");
      expect(() => prepareOpenCodeDevHost(f.home, f.config)).toThrow("non-symlink");
      rmSync(paths.signingKeyFile);
      symlinkSync(join(f.home, "nonexistent-key"), paths.signingKeyFile);
      expect(() => readOpenCodeDevHostKey(paths)).toThrow("non-symlink");
    } finally { f.clean(); }
  });

  test("starts a private OpenCode standalone process with only the generated identity", async () => {
    // The probe binary is a #!/bin/sh script; win32 cannot exec shebang files.
    if (process.platform === "win32") return;
    const f = fixture();
    try {
      const paths = prepareOpenCodeDevHost(f.home, f.config);
      const binary = join(f.home, "fake-opencode");
      const argsFile = join(f.home, "args.txt");
      const envFile = join(f.home, "env.txt");
      writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > "$PROBE_ARGS_FILE"\nprintf '%s\\n' "$HOME" "$XDG_CONFIG_HOME" "$CODEX_HOME" "$OPENCODE_CONFIG" "$OPENCODE_CHATGPT_WEB_BRIDGE_URL" > "$PROBE_ENV_FILE"\n`, { mode: 0o700 });
      const inherited = {
        HOME: "/old-home", CODEX_HOME: "/old-codex", OPENCODE_CONFIG: "/old-opencode.json",
        PROBE_ARGS_FILE: argsFile, PROBE_ENV_FILE: envFile, PATH: "/usr/bin",
      };
      expect(await runOpenCodeDevHost(paths, ["models"], { binary, inherited })).toBe(0);
      expect(readFileSync(argsFile, "utf8")).toBe("models\n--standalone\n");
      expect(readFileSync(envFile, "utf8")).toBe([
        paths.home, paths.configRoot, "", "", "http://127.0.0.1:17843", "",
      ].join("\n"));
      expect(() => runOpenCodeDevHost(paths, ["run", "--server=http://127.0.0.1:4096"], { binary, inherited }))
        .toThrow("standalone");
    } finally { f.clean(); }
  });

  test("reports provider catalog health for dev status without touching host OpenCode settings", () => {
    const f = fixture();
    try {
      const missing = readOpenCodeDevHostStatus(openCodeDevHostPaths(f.home));
      expect(missing.configured).toBe(false);
      expect(missing.pluginInstalled).toBe(false);
      expect(missing.error).toContain("run dev prepare-opencode");

      const prepared = prepareOpenCodeDevHost(f.home, f.config);
      const ready = readOpenCodeDevHostStatus(prepared);
      expect(ready).toMatchObject({ configured: true, pluginInstalled: true, listenerPort: 17843 });
      expect(ready.models).toBeGreaterThan(0);
      expect(ready.error).toBeUndefined();
    } finally { f.clean(); }
  });

  test("probes the isolated listener port so status can report a stopped listener", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port!;
    try {
      expect(await openCodeListenerRunning(port)).toBe(true);
      server.stop(true);
      await Bun.sleep(50);
      expect(await openCodeListenerRunning(port)).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
