/**
 * The upstream Codex harness binds turns and compaction to its native rollout.
 * OpenCode instead signs trusted V2 prompt/context/model-request hooks and
 * advances browser epochs only from its own scoped lifecycle event stream.
 * These tests exercise those hooks without touching real OpenCode sessions.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeIdentityPlugin } from "../src/opencode/identity-plugin";
import { consumeOpenCodeSessionDeletion } from "../src/opencode/session-lifecycle";
import { OpenCodeTurnVerifier, OPENCODE_TURN_HEADER } from "../src/opencode/turn-binding";

const SESSION = "ses_123456789";
const MODEL = { providerID: "opencode-chatgpt-web", id: "gpt-6" };
const TOOLS = { shell: { description: "Run a shell command", input: {
  type: "object", properties: { command: { type: "string" } },
} } };
const LOCATION = { directory: join(tmpdir(), "open-code-workspace"), workspaceID: "wrk_test" };

type LifecycleEvent = {
  type: string;
  data?: { sessionID?: string };
  location?: { directory?: string; workspaceID?: string };
};

function lifecycleStream() {
  const queued: LifecycleEvent[] = [];
  let next: ((item: IteratorResult<LifecycleEvent>) => void) | undefined;
  return {
    subscribe: (_options: { signal: AbortSignal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<LifecycleEvent>> => {
          const value = queued.shift();
          return value ? Promise.resolve({ value, done: false })
            : new Promise(resolve => { next = resolve; });
        },
      }),
    }),
    async send(event: LifecycleEvent): Promise<void> {
      if (next) {
        const resume = next;
        next = undefined;
        resume({ value: event, done: false });
      } else queued.push(event);
      // The subscriber handles the event in the next microtask.
      await new Promise(resolve => setTimeout(resolve, 0));
    },
    close(): void {
      next?.({ value: undefined, done: true });
      next = undefined;
    },
  };
}

async function fixture(
  sendDeletion?: (url: string, notice: string) => Promise<void>,
  pluginOptions: { keyFile?: string } = {},
) {
  const key = randomBytes(32);
  const verifier = new OpenCodeTurnVerifier(key);
  const hooks = new Map<string, (event: any) => unknown>();
  const events = lifecycleStream();
  const plugin = createOpenCodeIdentityPlugin({
    ...(pluginOptions.keyFile ? { keyFile: pluginOptions.keyFile } : { key: key.toString("hex") }),
    ...(sendDeletion ? { bridgeURL: "http://127.0.0.1:17841/", sendDeletion } : {}),
  });
  await plugin.setup({
    location: LOCATION,
    event: { subscribe: events.subscribe },
    session: {
      hook: async (name: string, callback: (event: any) => unknown) => { hooks.set(name, callback); },
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, location: { directory: LOCATION.directory }, projectID: "pro_123456789",
      }),
    },
  } as Parameters<typeof plugin.setup>[0]);
  const sign = async (sessionID = SESSION) => {
    const headers: Record<string, string> = {};
    await hooks.get("model.request")!({ sessionID, kind: "primary", model: MODEL, headers });
    return headers[OPENCODE_TURN_HEADER];
  };
  const begin = async (messageID = "msg_123456789", sessionID = SESSION) => {
    await hooks.get("prompt")!({ sessionID, messageID });
    await hooks.get("context")!({ sessionID, agent: "build", model: MODEL, tools: TOOLS });
  };
  return { hooks, events, verifier, sign, begin, key };
}

describe("OpenCode trusted identity plugin lifecycle", () => {
  test("signs only primary requests after trusted context, never for another provider", async () => {
    const f = await fixture();
    try {
      await expect(f.sign()).rejects.toThrow("No trusted OpenCode prompt");
      await f.begin();
      const headers: Record<string, string> = {};
      await f.hooks.get("model.request")!({ sessionID: SESSION, kind: "auxiliary", model: MODEL, headers });
      await f.hooks.get("model.request")!({ sessionID: SESSION, kind: "primary",
        model: { providerID: "another-provider", id: "gpt-6" }, headers });
      expect(headers).toEqual({});
      const signed = await f.sign();
      expect(typeof signed).toBe("string");
      const claims = f.verifier.verify(signed!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(claims.owner).toEqual({ cwd: LOCATION.directory, projectID: "pro_123456789", agent: "build" });
      expect(claims.compactionEpoch).toBe(0);
    } finally { f.events.close(); }
  });

  test("signs a compaction summary request with its own turn identity, and nothing else non-primary", async () => {
    const f = await fixture();
    try {
      await f.begin();
      const primary = f.verifier.verify((await f.sign())!, { model: "opencode-chatgpt-web/gpt-6" });

      const headers: Record<string, string> = {};
      await f.hooks.get("model.request")!({ sessionID: SESSION, kind: "compaction", model: MODEL, headers });
      const signed = headers[OPENCODE_TURN_HEADER];
      expect(typeof signed).toBe("string");
      const claims = f.verifier.verify(signed!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(claims.purpose).toBe("compaction");
      // One active turn per prompt: the summary keeps the originating identity
      // and only marks itself so the bridge can retire the in-flight browser.
      expect(claims.turnNonce).toBe(primary.turnNonce);
      expect(claims.turnStarted).toBe(primary.turnStarted);
      expect(claims.requestNonce).not.toBe(primary.requestNonce);
      expect(claims.compactionEpoch).toBe(primary.compactionEpoch);
      expect(claims.messageID).toBe(primary.messageID);

      // Unrelated request kinds stay unsigned for the bridge to reject.
      const other: Record<string, string> = {};
      await f.hooks.get("model.request")!({ sessionID: SESSION, kind: "title", model: MODEL, headers: other });
      expect(other).toEqual({});
    } finally { f.events.close(); }
  });

  test("holds a continuation until an in-flight compaction settles, then signs the new epoch", async () => {
    const f = await fixture();
    try {
      await f.begin();

      const summary: Record<string, string> = {};
      await f.hooks.get("model.request")!({ sessionID: SESSION, kind: "compaction", model: MODEL, headers: summary });
      expect(summary[OPENCODE_TURN_HEADER]).toBeString();

      await f.events.send({
        type: "session.compaction.started", data: { sessionID: SESSION }, location: LOCATION,
      });

      // OpenCode dispatches the continuation in the same tick as compaction.ended;
      // signing it before the epoch advances would be rejected as dropped history.
      const held: Record<string, string> = {};
      const pending = Promise.resolve(
        f.hooks.get("model.request")!({ sessionID: SESSION, kind: "primary", model: MODEL, headers: held }),
      ).then(() => "signed" as const);
      expect(await Promise.race([pending, Bun.sleep(20).then(() => "held" as const)])).toBe("held");
      expect(held).toEqual({});

      await f.events.send({
        type: "session.compaction.ended", data: { sessionID: SESSION }, location: LOCATION,
      });
      expect(await pending).toBe("signed");

      const claims = f.verifier.verify(held[OPENCODE_TURN_HEADER]!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(claims.compactionEpoch).toBe(1);
      expect(claims.purpose).toBeUndefined();
    } finally { f.events.close(); }
  });

  test("reads the bridge signing key from a key file so an install never copies the secret", async () => {
    const key = randomBytes(32);
    const keyFile = join(tmpdir(), `opencode-turn-key-${process.pid}-${Date.now()}`);
    writeFileSync(keyFile, `${key.toString("hex")}\n`, { mode: 0o600 });
    const f = await fixture(undefined, { keyFile });
    try {
      await f.begin();
      const signed = await f.sign();
      // The fixture verifier holds a different random key, so a signature that
      // verifies here proves the plugin read the key file itself.
      const fromFile = new OpenCodeTurnVerifier(key);
      expect(fromFile.verify(signed!, { model: "opencode-chatgpt-web/gpt-6" }).sessionID).toBe(SESSION);
    } finally {
      f.events.close();
      rmSync(keyFile, { force: true });
    }
  });

  test("an unreadable key file fails loudly instead of signing with another key", async () => {
    const missing = join(tmpdir(), `missing-opencode-key-${process.pid}-${Date.now()}`);
    const f = await fixture(undefined, { keyFile: missing });
    try {
      // The key is first needed when the session context activates its prompt,
      // so a broken install fails before any request is signed.
      await expect(f.begin()).rejects.toThrow("signing key file is unreadable");
    } finally { f.events.close(); }
  });

  test("scopes compaction, rotates browser epoch, and revokes deleted session at source", async () => {
    const f = await fixture();
    try {
      await f.begin();
      const first = f.verifier.verify((await f.sign())!, { model: "opencode-chatgpt-web/gpt-6" });
      await f.events.send({ type: "session.compaction.ended", data: { sessionID: SESSION },
        location: { directory: join(tmpdir(), "other-workspace"), workspaceID: LOCATION.workspaceID } });
      await f.events.send({ type: "session.compacted", data: { sessionID: SESSION },
        location: { directory: LOCATION.directory, workspaceID: "other-workspace" } });
      const unchanged = f.verifier.verify((await f.sign())!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(unchanged.compactionEpoch).toBe(0);
      await f.events.send({ type: "session.compaction.ended", data: { sessionID: SESSION }, location: LOCATION });
      const compacted = f.verifier.verify((await f.sign())!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(compacted.compactionEpoch).toBe(1);
      expect(compacted.turnNonce).toBe(first.turnNonce);
      await f.events.send({ type: "session.deleted", data: { sessionID: SESSION }, location: LOCATION });
      await expect(f.sign()).rejects.toThrow("No trusted OpenCode prompt");
      // A deleted session ID must not reset the bridge's compaction generation.
      await f.begin("msg_987654321");
      const reused = await f.sign();
      expect(() => f.verifier.verify(reused!, { model: "opencode-chatgpt-web/gpt-6" }))
        .toThrow("earlier compaction epoch");
      // A genuinely new OpenCode session has a distinct ID and can begin at epoch 0.
      const newSession = "ses_987654321";
      await f.begin("msg_987654321", newSession);
      const restarted = f.verifier.verify((await f.sign(newSession))!, { model: "opencode-chatgpt-web/gpt-6" });
      expect(restarted.sessionID).toBe(newSession);
      expect(restarted.compactionEpoch).toBe(0);
    } finally { f.events.close(); }
  });

  test("sends one signed deletion to the local bridge for the exact originating workspace", async () => {
    const delivered: { url: string; notice: string }[] = [];
    const f = await fixture(async (url, notice) => { delivered.push({ url, notice }); });
    try {
      await f.begin();
      f.verifier.verify((await f.sign())!, { model: "opencode-chatgpt-web/gpt-6" });
      await f.events.send({ type: "session.deleted", data: { sessionID: SESSION },
        location: { ...LOCATION, directory: join(tmpdir(), "foreign-workspace") } });
      await f.events.send({ type: "session.deleted", data: { sessionID: SESSION },
        location: { ...LOCATION, workspaceID: "foreign" } });
      expect(delivered).toEqual([]);
      await f.events.send({ type: "session.deleted", data: { sessionID: SESSION }, location: LOCATION });
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.url).toBe("http://127.0.0.1:17841/");
      expect(consumeOpenCodeSessionDeletion(delivered[0]!.notice, f.key, f.verifier))
        .toEqual({
          sessionID: SESSION,
          owner: { cwd: LOCATION.directory, projectID: "pro_123456789", agent: "build" },
          firstReceipt: true,
        });
      await expect(f.sign()).rejects.toThrow("No trusted OpenCode prompt");
      await f.events.send({ type: "session.deleted", data: { sessionID: SESSION }, location: LOCATION });
      expect(delivered).toHaveLength(1);
    } finally { f.events.close(); }
  });
});
