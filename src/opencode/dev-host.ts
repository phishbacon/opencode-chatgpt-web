/**
 * The upstream Codex harness installs its provider and turn identity into
 * Codex's native model catalog and Responses service. OpenCode instead owns
 * its model catalog, session state and permissions. This module provisions an
 * isolated OpenCode DEV home with the same browser-backed Responses provider,
 * trusted V2 identity plugin, and a private key shared with the DEV listener.
 * It never changes the user's existing OpenCode installation or credentials.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import { assertOpenCodeDevListenerConfig } from "./dev-listener";
import { parseTurnSigningKey } from "./turn-binding";

const DEFAULT_DEV_PORT = 17843;
const PROVIDER_ID = "opencode-chatgpt-web";

export interface OpenCodeDevHostPaths {
  root: string;
  home: string;
  configRoot: string;
  configFile: string;
  pluginFile: string;
  dataRoot: string;
  cacheRoot: string;
  stateRoot: string;
  signingKeyFile: string;
}

export function openCodeDevHostPaths(profileHome: string): OpenCodeDevHostPaths {
  if (!isAbsolute(profileHome) || resolve(profileHome) !== profileHome) {
    throw new Error("OpenCode DEV host requires an absolute, canonical DEV profile home");
  }
  const root = join(profileHome, "opencode-host");
  const configRoot = join(root, "config");
  return {
    root,
    home: join(root, "home"),
    configRoot,
    configFile: join(configRoot, "opencode", "opencode.json"),
    pluginFile: join(configRoot, "opencode", "plugins", "chatgpt-web-identity.js"),
    dataRoot: join(root, "data"),
    cacheRoot: join(root, "cache"),
    stateRoot: join(root, "state"),
    signingKeyFile: join(root, "turn-signing.key"),
  };
}

function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`OpenCode DEV host requires a private, non-symlink directory: ${path}`);
  }
  // POSIX mode bits are not enforced on win32 (mkdir ignores them, lstat reports
  // fabricated bits), so the privacy assertion only holds on POSIX platforms.
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(`OpenCode DEV host requires a private, non-symlink directory: ${path}`);
  }
}

function privateFile(path: string): string | undefined {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
    throw new Error(`OpenCode DEV host requires a private, non-symlink file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

function createOrVerifyFile(path: string, content: string): void {
  const previous = privateFile(path);
  if (previous !== undefined) {
    if (previous !== content) throw new Error(`OpenCode DEV host refuses to overwrite an existing file: ${path}`);
    return;
  }
  try {
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || privateFile(path) !== content) throw error;
  }
}

export function readOpenCodeDevHostKey(paths: OpenCodeDevHostPaths): Buffer {
  const content = privateFile(paths.signingKeyFile);
  if (content === undefined) throw new Error("OpenCode DEV host signing key is missing; run dev prepare-opencode");
  return parseTurnSigningKey(content.trim());
}

export function readOpenCodeDevHostPort(paths: OpenCodeDevHostPaths): number {
  const content = privateFile(paths.configFile);
  if (content === undefined) throw new Error("OpenCode DEV provider config is missing; run dev prepare-opencode");
  let json: unknown;
  try { json = JSON.parse(content); }
  catch { throw new Error("OpenCode DEV provider config is not valid JSON"); }
  const baseURL = (json as { providers?: Record<string, { settings?: { baseURL?: string } }> } | null)
    ?.providers?.[PROVIDER_ID]?.settings?.baseURL;
  if (typeof baseURL !== "string") throw new Error("OpenCode DEV provider URL is missing");
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("OpenCode DEV provider URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1"
    || !url.port || Number(url.port) === 17841 || url.search || url.hash) {
    throw new Error("OpenCode DEV provider must point to its isolated loopback listener");
  }
  return Number(url.port);
}

/**
 * Content-free health snapshot for `dev status`: whether the isolated provider
 * catalog and identity plugin are present, how many models OpenCode would list,
 * and which loopback port the DEV listener must own.
 */
export function readOpenCodeDevHostStatus(paths: OpenCodeDevHostPaths): {
  configured: boolean;
  models: number;
  pluginInstalled: boolean;
  listenerPort?: number;
  error?: string;
} {
  const pluginInstalled = privateFile(paths.pluginFile) !== undefined;
  const content = privateFile(paths.configFile);
  if (content === undefined) {
    return { configured: false, models: 0, pluginInstalled, error: "provider config is missing; run dev prepare-opencode" };
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { configured: false, models: 0, pluginInstalled, error: "provider config is not valid JSON" };
  }
  const providers = (json as { providers?: Record<string, { models?: Record<string, unknown> }> }).providers ?? {};
  const models = Object.values(providers).reduce((total, provider) => total + Object.keys(provider.models ?? {}).length, 0);
  try {
    return { configured: true, models, pluginInstalled, listenerPort: readOpenCodeDevHostPort(paths) };
  } catch (error) {
    return { configured: true, models, pluginInstalled, error: error instanceof Error ? error.message : String(error) };
  }
}

/** True when something accepts connections on the isolated listener port. */
export function openCodeListenerRunning(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

export function prepareOpenCodeDevHost(
  profileHome: string,
  config: AppConfig,
  { port = DEFAULT_DEV_PORT, identityModule = join(import.meta.dir, "identity-plugin.ts") }: {
    port?: number;
    identityModule?: string;
  } = {},
): OpenCodeDevHostPaths {
  assertOpenCodeDevListenerConfig({ ...config, port }, { profileHome });
  if (!isAbsolute(identityModule)) throw new Error("OpenCode DEV identity plugin import must be absolute");
  const paths = openCodeDevHostPaths(profileHome);
  const routes = availableChatGptWebModelRoutes(config);
  if (routes.length === 0 || routes.some(route => route.interactionMode !== "automatic")) {
    throw new Error("OpenCode DEV host needs at least one automatic ChatGPT browser model");
  }
  const models = Object.fromEntries(routes.map(route => {
    const suffix = route.slug.slice("chatgpt-web/".length);
    const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
      route.interactionMode === "automatic" ? route.modelFamily : undefined);
    return [suffix, {
      name: route.displayName,
      modelID: `${PROVIDER_ID}/${suffix}`,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      // Expose the practical pre-compaction budget, not the raw window: OpenCode
      // compacts near limit.context, and a compaction summary that approaches the
      // measured ChatGPT Web window is rejected by the browser-side size guard.
      limit: { context: limits.autoCompactTokenLimit, output: Math.min(16_384, Math.floor(limits.contextWindow / 8)) },
    }];
  }));
  const defaultModel = routes.find(route => route.slug === "chatgpt-web/gpt-6-sol") ?? routes[0]!;
  const providerConfig = {
    providers: {
      [PROVIDER_ID]: {
        name: "OpenCode ChatGPT",
        package: "@opencode/ai/providers/openai/responses",
        settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "local-dev-bridge-no-secret" },
        models,
      },
    },
    model: `${PROVIDER_ID}/${defaultModel.slug.slice("chatgpt-web/".length)}`,
    plugins: { paths: [] },
  };
  const pluginSource = `/**\n * Upstream OpenCode signs its own native turn metadata before Responses dispatch.\n * OpenCode uses this V2 hook plugin to sign host-owned turn identity and tool\n * inventory; the Electron browser and native tool permissions remain separate.\n */\nimport { createOpenCodeIdentityPlugin } from ${JSON.stringify(pathToFileURL(identityModule).href)};\nexport default createOpenCodeIdentityPlugin();\n`;

  privateDirectory(profileHome);
  for (const dir of [paths.root, paths.home, paths.configRoot, join(paths.configRoot, "opencode"),
    join(paths.configRoot, "opencode", "plugins"), paths.dataRoot, paths.cacheRoot, paths.stateRoot]) {
    privateDirectory(dir);
  }
  const existingKey = privateFile(paths.signingKeyFile);
  if (existingKey === undefined) {
    try { writeFileSync(paths.signingKeyFile, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  readOpenCodeDevHostKey(paths);
  createOrVerifyFile(paths.configFile, `${JSON.stringify(providerConfig, null, 2)}\n`);
  createOrVerifyFile(paths.pluginFile, pluginSource);
  return paths;
}

export function openCodeDevHostEnvironment(
  paths: OpenCodeDevHostPaths,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE_") || key.startsWith("CODEX_")) delete env[key];
  }
  const port = readOpenCodeDevHostPort(paths);
  env.HOME = paths.home;
  env.XDG_CONFIG_HOME = paths.configRoot;
  env.XDG_DATA_HOME = paths.dataRoot;
  env.XDG_CACHE_HOME = paths.cacheRoot;
  env.XDG_STATE_HOME = paths.stateRoot;
  env.OPENCODE_CHATGPT_WEB_TURN_KEY = readOpenCodeDevHostKey(paths).toString("hex");
  env.OPENCODE_CHATGPT_WEB_BRIDGE_URL = `http://127.0.0.1:${port}`;
  return env;
}

/**
 * Codex starts its own native harness against the managed Responses bridge.
 * OpenCode must start its own harness under the private DEV home so its models,
 * sessions, identity hooks, and tool permissions remain owned by OpenCode.
 */
export async function runOpenCodeDevHost(
  paths: OpenCodeDevHostPaths,
  args: string[],
  options: { binary?: string; inherited?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<number> {
  if (args.some(arg => arg === "--server" || arg.startsWith("--server="))) {
    throw new Error("OpenCode DEV host must use --standalone, not an existing OpenCode server");
  }
  // Verify that the provider and identity key were installed before starting.
  const env = openCodeDevHostEnvironment(paths, options.inherited);
  if (privateFile(paths.pluginFile) === undefined) {
    throw new Error("OpenCode DEV identity plugin is missing; run dev prepare-opencode");
  }
  const defaultBinary = join(homedir(), ".opencode", "bin", "opencode");
  const binary = options.binary ?? process.env.OPENCODE_BINARY
    ?? (existsSync(defaultBinary) ? defaultBinary : "opencode");
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(binary, [...args, "--standalone"], {
      env, cwd: options.cwd ?? process.cwd(), stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal ? 130 : code ?? 1));
  });
}
