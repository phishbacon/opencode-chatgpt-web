/**
 * Keep OpenCode's opencode-chatgpt-web provider limits aligned with the limits
 * the bridge actually enforces. The Bigger Context toggle lives in the bridge
 * config; the bridge publishes its resolved per-model limits on /healthz and
 * this host-side sync (driven by the identity plugin) rewrites limit.context
 * in opencode.json. OpenCode watches its config, so the model picker and
 * auto-compaction threshold follow the toggle without a manual edit.
 */
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OpenCodeModelLimit { contextWindow: number; autoCompactTokenLimit: number }

/** OpenCode's config path, honoring the same XDG rules OpenCode uses. */
export function opencodeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join((env.HOME?.trim() || homedir()), ".config");
  return join(base, "opencode", "opencode.json");
}

/**
 * Fetch the bridge's live limits and write them into the provider's
 * limit.context values. Returns true only when the file actually changed;
 * never throws for a restarting bridge or an unreadable config (callers treat
 * "not aligned yet" as skippable).
 */
export async function syncOpenCodeProviderLimits(options: {
  bridgeURL: string;
  providerID?: string;
  configPath?: string;
  fetchImpl?: (input: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}): Promise<boolean> {
  const providerID = options.providerID ?? "opencode-chatgpt-web";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.bridgeURL.replace(/\/+$/, "")}/healthz`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return false;
  const payload = await response.json() as { openCodeModelLimits?: Record<string, OpenCodeModelLimit> };
  const bridgeLimits = payload.openCodeModelLimits;
  if (!bridgeLimits || Object.keys(bridgeLimits).length === 0) return false;

  const configPath = options.configPath ?? opencodeConfigPath();
  let source: string;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  let config: Record<string, any>;
  try {
    config = JSON.parse(source) as Record<string, any>;
  } catch {
    return false;
  }
  const models = config?.providers?.[providerID]?.models;
  if (!models || typeof models !== "object") return false;

  let changed = false;
  for (const [suffix, limits] of Object.entries(bridgeLimits)) {
    const model = (models as Record<string, Record<string, any>>)[suffix];
    if (!model || typeof model !== "object") continue;
    const budget = limits.autoCompactTokenLimit;
    if (!Number.isFinite(budget)) continue;
    if (model.limit?.context === budget) continue;
    model.limit = { ...(model.limit ?? {}), context: budget };
    changed = true;
  }
  if (!changed) return false;

  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(temporary, statSync(configPath).mode & 0o777);
    } catch { /* keep0600 */ }
    renameSync(temporary, configPath);
    return true;
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return false;
  }
}
