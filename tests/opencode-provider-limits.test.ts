/**
 * The Bigger Context toggle lives bridge-side; /healthz publishes the resolved
 * limits and this host-side sync keeps opencode.json's provider limit.context
 * on the bridge's pre-compaction budget so OpenCode compacts before the
 * browser-side size guard instead of at its edge.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeConfigPath, syncOpenCodeProviderLimits } from "../src/opencode/provider-limits";

const HEALTH = {
  openCodeModelLimits: {
    "gpt-6-sol": { contextWindow: 120000, autoCompactTokenLimit: 110000 },
    "gpt-6-sol-instant": { contextWindow: 41000, autoCompactTokenLimit: 32000 },
    "gpt-5.6-sol": { contextWindow: 270000, autoCompactTokenLimit: 240000 },
  },
};

function fixtureConfig() {
  return {
    providers: {
      "opencode-chatgpt-web": { models: {
        "gpt-6-sol": { name: "GPT-6 Sol", limit: { context: 120000, output: 15000 } },
        "gpt-6-sol-instant": { name: "Instant", limit: { context: 41000, output: 5125 } },
      } },
      "caveman-auto": { models: { x: { limit: { context: 1000, output: 100 } } } },
    },
  };
}

function setup(config = fixtureConfig()) {
  const dir = mkdtempSync(join(tmpdir(), "opencode-limits-"));
  const configPath = join(dir, "opencode.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const fetchImpl = (async () => Response.json(HEALTH));
  return { configPath, fetchImpl };
}

describe("OpenCode provider limit sync", () => {
  test("syncs provider limits to the bridge budgets without touching other providers", async () => {
    const { configPath, fetchImpl } = setup();
    expect(await syncOpenCodeProviderLimits({ bridgeURL: "http://127.0.0.1:1/", configPath, fetchImpl })).toBe(true);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.providers["opencode-chatgpt-web"].models["gpt-6-sol"].limit).toEqual({ context: 110000, output: 15000 });
    expect(after.providers["opencode-chatgpt-web"].models["gpt-6-sol-instant"].limit.context).toBe(32000);
    expect(after.providers["caveman-auto"].models.x.limit.context).toBe(1000);
  });

  test("is a byte-identical no-op when already aligned", async () => {
    const aligned = fixtureConfig();
    aligned.providers["opencode-chatgpt-web"].models["gpt-6-sol"].limit.context = 110000;
    aligned.providers["opencode-chatgpt-web"].models["gpt-6-sol-instant"].limit.context = 32000;
    const { configPath, fetchImpl } = setup(aligned);
    const before = readFileSync(configPath, "utf8");
    expect(await syncOpenCodeProviderLimits({ bridgeURL: "http://x/", configPath, fetchImpl })).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("never adds models the provider does not declare", async () => {
    const { configPath, fetchImpl } = setup();
    await syncOpenCodeProviderLimits({ bridgeURL: "http://x/", configPath, fetchImpl });
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.providers["opencode-chatgpt-web"].models["gpt-5.6-sol"]).toBeUndefined();
  });

  test("reports false when the bridge publishes no limits, and surfaces transport errors", async () => {
    const { configPath } = setup();
    const empty = (async () => Response.json({ status: "ok" }));
    expect(await syncOpenCodeProviderLimits({ bridgeURL: "http://x/", configPath, fetchImpl: empty })).toBe(false);
    const down = (async () => { throw new Error("ECONNREFUSED"); });
    await expect(syncOpenCodeProviderLimits({ bridgeURL: "http://x/", configPath, fetchImpl: down }))
      .rejects.toThrow("ECONNREFUSED");
  });

  test("leaves malformed configs untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-limits-bad-"));
    const bad = join(dir, "opencode.json");
    writeFileSync(bad, "{not json");
    const ok = (async () => Response.json(HEALTH));
    expect(await syncOpenCodeProviderLimits({ bridgeURL: "http://x/", configPath: bad, fetchImpl: ok })).toBe(false);
    expect(readFileSync(bad, "utf8")).toBe("{not json");
  });

  test("opencodeConfigPath honors XDG_CONFIG_HOME and HOME", () => {
    expect(opencodeConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }))
      .toBe(join("/xdg", "opencode", "opencode.json"));
    expect(opencodeConfigPath({ HOME: "/home/u" }))
      .toBe(join("/home/u", ".config", "opencode", "opencode.json"));
  });
});
