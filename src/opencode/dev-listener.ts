/**
 * The original Codex harness exposes a broad Responses bridge because Codex
 * owns its native models, lifecycle and passthrough routes. OpenCode instead
 * owns those capabilities itself: this isolated DEV listener accepts only
 * signed OpenCode turns and signed session retirement, then reuses the Codex
 * browser/Responses implementation without exposing its native Codex routes.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { defaultBrokerEndpoint, type AppConfig } from "../config";
import { readJsonRequestBody } from "../http-body";
import { OPENCODE_SESSION_DELETED_HEADER, OPENCODE_SESSION_DELETED_PATH } from "./session-lifecycle";
import { OPENCODE_WEBSITE_CONNECTOR_DEV_NAME } from "./website-connector";
import { verifyOpenCodeResponsesIngress } from "./request-auth";
import type { OpenCodeTurnVerifier } from "./turn-binding";
import type { OpenCodeToolReceiptLedger } from "./tool-receipts";

export interface OpenCodeDevListenerOptions {
  profileHome: string;
  /** Bun's ephemeral port is permitted in in-process tests only. */
  allowEphemeralPort?: boolean;
}

function contained(root: string, candidate: string): boolean {
  if (!candidate || !isAbsolute(candidate)) return false;
  const path = relative(root, resolve(candidate));
  return Boolean(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(path);
}

/** Preflight before the Codex bridge binds its HTTP port or broker socket. */
export function assertOpenCodeDevListenerConfig(config: AppConfig, options: OpenCodeDevListenerOptions): void {
  const home = options.profileHome;
  if (!home || !isAbsolute(home) || resolve(home) !== home) {
    throw new Error("OpenCode DEV listener requires a canonical isolated profile home");
  }
  if (config.purpose !== "dev-harness" || config.mode !== "full"
    || config.websiteMcpContract !== "opencode" || config.browserInteractionMode !== "automatic"
    || config.appName !== OPENCODE_WEBSITE_CONNECTOR_DEV_NAME
    || config.automaticAppName !== OPENCODE_WEBSITE_CONNECTOR_DEV_NAME) {
    throw new Error("OpenCode DEV listener requires the isolated automatic Full Harness connector");
  }
  if (config.host !== "127.0.0.1" || config.port === 17841
    || (!options.allowEphemeralPort && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535))
    || (options.allowEphemeralPort && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535))) {
    throw new Error("OpenCode DEV listener must use a separate loopback port from native OpenCode");
  }
  if (config.browserHost !== "launcher" || !contained(home, config.browserHostDescriptorPath ?? "")
    || !contained(home, config.storageStatePath)
    || config.brokerSocketPath !== defaultBrokerEndpoint(home)) {
    throw new Error("OpenCode DEV listener requires its own launcher, browser state and broker socket");
  }
}

/** A rejected request never consumes a signed turn nonce or reaches upstream Codex. */
export async function guardOpenCodeDevHttpRequest(
  req: Request,
  verifier: OpenCodeTurnVerifier,
  receipts: OpenCodeToolReceiptLedger,
  deletionKey: Buffer,
): Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/healthz") return undefined;
  if (req.method === "POST" && path === OPENCODE_SESSION_DELETED_PATH) {
    return req.headers.has(OPENCODE_SESSION_DELETED_HEADER) && deletionKey.length === 32
      ? undefined
      : new Response("Signed OpenCode session deletion required", { status: 401 });
  }
  if (req.method !== "POST" || path !== "/v1/responses") {
    return new Response("OpenCode DEV route unavailable", { status: 404 });
  }
  let body: unknown;
  try {
    body = await readJsonRequestBody(req.clone());
  } catch {
    return new Response("Invalid OpenCode Responses JSON", { status: 400 });
  }
  try {
    const claims = verifyOpenCodeResponsesIngress(req, body, verifier, { consume: false, receipts });
    if (!claims) throw new Error("Signed OpenCode provider model required");
  } catch (error) {
    const record = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    const model = typeof record?.model === "string" ? record.model : "(unknown)";
    console.error(`[opencode-ingress] ${new Date().toISOString()} rejected model=${model}: ${error instanceof Error ? error.message : String(error)}`);
    return new Response("Signed OpenCode Responses request rejected", { status: 401 });
  }
  return undefined;
}
