/**
 * The original Codex harness listens for native Codex Responses and lifecycle
 * routes on its own trusted local service. OpenCode reuses its browser adapter
 * but runs an isolated DEV listener limited to signed OpenCode turns and signed
 * session deletion; these tests verify that Codex routes cannot escape into it.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { assertOpenCodeDevListenerConfig } from "../src/opencode/dev-listener";
import {
  OPENCODE_SESSION_DELETED_HEADER, OPENCODE_SESSION_DELETED_PATH, signOpenCodeSessionDeletion,
} from "../src/opencode/session-lifecycle";
import { OpenCodeToolReceiptLedger } from "../src/opencode/tool-receipts";
import { OPENCODE_WEBSITE_CONNECTOR_DEV_NAME } from "../src/opencode/website-connector";
import { OpenCodeTurnIssuer, OpenCodeTurnVerifier, OPENCODE_TURN_HEADER } from "../src/opencode/turn-binding";
import { startServer } from "../src/server";

const MODEL = "opencode-chatgpt-web/light";
const OWNER = { cwd: "/tmp/example-workspace", projectID: "pro_123456789", agent: "build" };
const SESSION = "ses_123456789";
const TOOLS = {
  read: { description: "Read file", input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
};
const WIRE_TOOLS = [{
  type: "function", name: "read", description: TOOLS.read.description, parameters: TOOLS.read.input, strict: false,
}];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "opencode-dev-http-"));
  const config = {
    ...defaultConfig("full"),
    purpose: "dev-harness" as const,
    port: 0,
    browserInteractionMode: "automatic" as const,
    websiteMcpContract: "opencode" as const,
    appName: OPENCODE_WEBSITE_CONNECTOR_DEV_NAME,
    automaticAppName: OPENCODE_WEBSITE_CONNECTOR_DEV_NAME,
    browserHost: "launcher" as const,
    browserHostDescriptorPath: join(home, "runtime", "launcher-browser.json"),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
  };
  mkdirSync(join(home, "runtime"), { recursive: true });
  const key = randomBytes(32);
  const issuer = new OpenCodeTurnIssuer(key);
  const verifier = new OpenCodeTurnVerifier(key);
  issuer.beginPrompt(SESSION, "msg_123456789");
  issuer.observeContext(SESSION, MODEL, TOOLS, OWNER);
  const body = { model: MODEL, input: "Read a fixture", stream: false, tools: WIRE_TOOLS };
  return { home, config, key, issuer, verifier, body, receipts: new OpenCodeToolReceiptLedger() };
}

describe("isolated OpenCode DEV Responses listener", () => {
  test("requires canonical profile, independent socket and automatic OpenCode connector before binding", () => {
    const f = fixture();
    try {
      const options = { profileHome: f.home, allowEphemeralPort: true };
      expect(() => assertOpenCodeDevListenerConfig(f.config, options)).not.toThrow();
      const invalid = [
        { purpose: undefined },
        { mode: "browser-only" as const },
        { websiteMcpContract: undefined },
        { browserInteractionMode: "manual" as const },
        { automaticAppName: "OpenCode Native2" },
        { appName: "OpenCode Native2" },
        { host: "0.0.0.0" as never },
        { port: 17841 },
        { browserHost: "managed-chrome" as const },
        { browserHostDescriptorPath: join(f.home, "..", "external-browser.json") },
        { storageStatePath: join(f.home, "..", "external-state.json") },
        { brokerSocketPath: defaultBrokerEndpoint(join(f.home, "..", "external")) },
      ];
      for (const alteration of invalid) {
        expect(() => assertOpenCodeDevListenerConfig({ ...f.config, ...alteration }, options)).toThrow();
      }
      expect(() => assertOpenCodeDevListenerConfig(f.config, { profileHome: "." })).toThrow("canonical");
      expect(() => assertOpenCodeDevListenerConfig(f.config, { profileHome: f.home })).toThrow("port");
      expect(() => startServer(f.config)).toThrow("cannot start");
      expect(() => startServer(f.config, { openCodeDevListener: options })).toThrow("signed turn");
      expect(() => startServer(f.config, {
        openCodeDevListener: options, openCodeTurnVerifier: f.verifier,
      })).toThrow("signed turn");
      expect(() => startServer(f.config, {
        openCodeDevListener: options, openCodeSessionDeletionKey: f.key,
      })).toThrow("signed turn");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("live HTTP rejects unsigned, forged, replayed and OpenCode traffic; accepts owned turn and deletion", async () => {
    const f = fixture();
    let calls = 0;
    let upstreamCalls = 0;
    const server = startServer(f.config, {
      openCodeDevListener: { profileHome: f.home, allowEphemeralPort: true },
      openCodeTurnVerifier: f.verifier,
      openCodeSessionDeletionKey: f.key,
      openCodeToolReceipts: f.receipts,
      fetchUpstream: (async () => { upstreamCalls++; throw new Error("upstream OpenCode must be unreachable"); }) as never,
      adapterFactory: () => ({
        name: "openCode-dev-adapter-probe",
        async runTurn(_parsed, _incoming, emit) {
          calls++;
          emit({ type: "text_delta", text: "signed browser result", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    const send = async (path: string, body: unknown = f.body, signature?: string, extraHeaders: Record<string, string> = {}) => fetch(`${base}${path}`, {
      method: "POST", headers: {
        "content-type": "application/json",
        ...(signature ? { [OPENCODE_TURN_HEADER]: signature } : {}), ...extraHeaders,
      }, body: JSON.stringify(body),
    });
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      for (const path of ["/v1/models", "/v1/responses/compact", "/v1/alpha/search",
        "/v1/images/generations", "/v1/images/edits", "/admin/resume", "/admin/drain",
        "/admin/cancel-turn", "/internal/other", "/"]) {
        expect((await send(path)).status).toBe(404);
      }
      expect((await fetch(`${base}/v1/responses`)).status).toBe(404);
      expect((await send("/v1/responses")).status).toBe(401);
      expect((await send("/v1/responses", f.body, "forged.signature")).status).toBe(401);
      expect((await send("/v1/responses", { ...f.body, model: "chatgpt-web/gpt-6" })).status).toBe(401);
      expect((await fetch(`${base}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{",
      })).status).toBe(400);

      const signed = f.issuer.signPrimaryRequest(SESSION, MODEL);
      expect((await send("/v1/responses", { ...f.body, tools: [] }, signed)).status).toBe(401);
      expect((await send("/v1/responses", f.body, signed, { origin: "http://localhost" })).status).toBe(403);
      const accepted = await send("/v1/responses", f.body, signed);
      expect(accepted.status).toBe(200);
      expect((await accepted.text())).toContain("signed browser result");
      expect((await send("/v1/responses", f.body, signed)).status).toBe(401);
      expect(calls).toBe(1);
      expect(upstreamCalls).toBe(0);

      const deletion = signOpenCodeSessionDeletion(f.key, SESSION, OWNER);
      const deleteNotice = () => fetch(`${base}${OPENCODE_SESSION_DELETED_PATH}`, {
        method: "POST", headers: { [OPENCODE_SESSION_DELETED_HEADER]: deletion },
      });
      expect((await send(OPENCODE_SESSION_DELETED_PATH)).status).toBe(401);
      expect((await fetch(`${base}${OPENCODE_SESSION_DELETED_PATH}`, {
        method: "POST", headers: { [OPENCODE_SESSION_DELETED_HEADER]: "forged.signature" },
      })).status).toBe(401);
      const deleted = await deleteNotice();
      expect(deleted.status).toBe(200);
      expect((await deleted.json() as { retired_session: string }).retired_session).toBe(SESSION);
      expect((await deleteNotice()).status).toBe(200);
      expect((await send("/v1/responses", f.body, f.issuer.signPrimaryRequest(SESSION, MODEL))).status).toBe(401);
      expect(calls).toBe(1);
      expect(upstreamCalls).toBe(0);
    } finally {
      await server.stop(true);
      await TurnBroker.forSocket(f.config.brokerSocketPath).close();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
});
