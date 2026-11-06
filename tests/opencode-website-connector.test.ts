/**
 * The original Codex harness chooses its native or Zero Risk website MCP
 * contract during setup and tunnel launch. OpenCode retains that transport but
 * selects its own connector and tool contract only for signed, automatic
 * full-harness turns; the isolated DEV harness uses the upstream `${name} DEV`
 * connector form. These tests cover configuration and tunnel boundaries.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, loadConfig, loadConfigForSetup, saveConfig } from "../src/config";
import { assertDevConnectorIdentity } from "../src/dev-chat/cli";
import { tunnelWorkerRuntimeChanged } from "../src/setup";
import { mcpCommand } from "../src/tunnel";
import {
  OPENCODE_WEBSITE_CONNECTOR_DEV_NAME,
  OPENCODE_WEBSITE_CONNECTOR_NAME,
  openCodeWebsiteConnectorName,
  resolveWebsiteMcpContract,
} from "../src/opencode/website-connector";

describe("OpenCode website connector selection", () => {
  test("DEV chat accepts the configured OpenCode website plugin without weakening OpenCode isolation", () => {
    expect(openCodeWebsiteConnectorName("development")).toBe(OPENCODE_WEBSITE_CONNECTOR_DEV_NAME);
    expect(openCodeWebsiteConnectorName("production")).toBe(OPENCODE_WEBSITE_CONNECTOR_NAME);
    expect(() => assertDevConnectorIdentity({ mode: "full", appName: OPENCODE_WEBSITE_CONNECTOR_DEV_NAME, websiteMcpContract: "opencode" }))
      .not.toThrow();
    expect(() => assertDevConnectorIdentity({ mode: "full", appName: "OpenCode Native2 DEV" }))
      .not.toThrow();
    expect(() => assertDevConnectorIdentity({ mode: "full", appName: "OpenCode Native2 DEV", websiteMcpContract: "opencode" }))
      .toThrow("identity is outdated");
    // The production plugin name is not a DEV-harness identity.
    expect(() => assertDevConnectorIdentity({ mode: "full", appName: OPENCODE_WEBSITE_CONNECTOR_NAME, websiteMcpContract: "opencode" }))
      .toThrow("identity is outdated");
    expect(() => assertDevConnectorIdentity({ mode: "full", appName: OPENCODE_WEBSITE_CONNECTOR_NAME }))
      .toThrow("identity is outdated");
  });

  test("upstream OpenCode contracts remain the default", () => {
    expect(resolveWebsiteMcpContract({ browserInteractionMode: "automatic" })).toBe("native");
    expect(resolveWebsiteMcpContract({ browserInteractionMode: "manual" })).toBe("safe");
    expect(resolveWebsiteMcpContract({ browserInteractionMode: "automatic", websiteMcpContract: "opencode" }))
      .toBe("opencode");
    expect(() => resolveWebsiteMcpContract({ browserInteractionMode: "manual", websiteMcpContract: "opencode" }))
      .toThrow("automatic browser interaction");
  });

  test("full automatic config round-trips without touching the real profile", () => {
    const previous = process.env.CODEX_CHATGPT_WEB_HOME;
    const root = mkdtempSync(join(tmpdir(), "opencode-website-connector-"));
    try {
      process.env.CODEX_CHATGPT_WEB_HOME = root;
      const config = defaultConfig("full");
      config.websiteMcpContract = "opencode";
      config.appName = OPENCODE_WEBSITE_CONNECTOR_NAME;
      config.automaticAppName = OPENCODE_WEBSITE_CONNECTOR_NAME;
      config.runtimeCommand = [process.execPath, join(process.cwd(), "fixture runner.ts")];
      config.tunnel = {
        binaryPath: "/usr/bin/cloudflared",
        tunnelId: `tunnel_${"a".repeat(32)}`,
        runtimeKeyFile: join(root, "fixture-key"),
        profileDir: join(root, "fixture-profile"),
        profileName: "fixture",
        alias: "fixture",
      };
      saveConfig(config);
      expect(loadConfig()).toMatchObject(config);
      expect(loadConfigForSetup()).toMatchObject(config);
      expect(mcpCommand(config, "linux")).toContain("--contract opencode");
      expect(mcpCommand(config, "linux")).toContain(`'${join(process.cwd(), "fixture runner.ts")}'`);
      expect(mcpCommand(config, "win32")).toContain('"--contract" "opencode"');

      const updated = structuredClone(config);
      updated.websiteMcpContract = undefined;
      expect(tunnelWorkerRuntimeChanged(config, updated)).toBe(true);
      expect(tunnelWorkerRuntimeChanged(config, structuredClone(config))).toBe(false);

      for (const invalid of [
        { ...config, mode: "browser-only" },
        { ...config, browserInteractionMode: "manual" },
        { ...config, appName: "OpenCode Native2" },
        { ...config, automaticAppName: "OpenCode Native2" },
        { ...config, websiteMcpContract: "unknown" },
      ]) {
        saveConfig(invalid as typeof config);
        expect(() => loadConfig()).toThrow();
      }
      saveConfig(config);
      expect(loadConfig().websiteMcpContract).toBe("opencode");

      const devNamed = structuredClone(config);
      devNamed.appName = OPENCODE_WEBSITE_CONNECTOR_DEV_NAME;
      devNamed.automaticAppName = OPENCODE_WEBSITE_CONNECTOR_DEV_NAME;
      saveConfig(devNamed);
      expect(loadConfig().automaticAppName).toBe(OPENCODE_WEBSITE_CONNECTOR_DEV_NAME);
    } finally {
      if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
      else process.env.CODEX_CHATGPT_WEB_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
