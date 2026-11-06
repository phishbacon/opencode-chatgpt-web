/**
 * The original Codex harness retires browser tabs and tool capabilities from
 * its own native session lifecycle. OpenCode must authenticate the equivalent
 * host session.deleted event with a signed, owner-bound notice to the local
 * Responses bridge; these tests cover rejection, retry, and physical cleanup.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { defaultConfig } from "../src/config";
import { chatGptTurnSessions, ChatGptTextFeed, ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import {
  consumeOpenCodeSessionDeletion, localOpenCodeBridgeURL,
  OPENCODE_SESSION_DELETED_HEADER, OPENCODE_SESSION_DELETED_PATH,
  sendOpenCodeSessionDeletion, signOpenCodeSessionDeletion,
} from "../src/opencode/session-lifecycle";
import { OpenCodeTurnIssuer, OpenCodeTurnVerifier } from "../src/opencode/turn-binding";
import { startServer } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

const SESSION = "ses_123456789";
const OWNER = { cwd: join(tmpdir(), "example-workspace"), projectID: "pro_123456789", agent: "build" };
const MODEL = "opencode-chatgpt-web/light";
const TOOLS = { shell: { description: "Execute a command", input: { type: "object", properties: {} } } };

function fixture(now = 1_800_000_000_000) {
  const key = randomBytes(32);
  const verifier = new OpenCodeTurnVerifier(key, () => now);
  const issuer = new OpenCodeTurnIssuer(key, () => now);
  issuer.beginPrompt(SESSION, "msg_123456789");
  issuer.observeContext(SESSION, MODEL, TOOLS, OWNER);
  const notice = signOpenCodeSessionDeletion(key, SESSION, OWNER, now);
  return { key, verifier, issuer, notice, now };
}

describe("OpenCode signed deletion notices", () => {
  test("retires a previously accepted owner and rejects every future continuation", () => {
    const f = fixture();
    f.verifier.verify(f.issuer.signPrimaryRequest(SESSION, MODEL), { model: MODEL });
    const pending = f.issuer.signPrimaryRequest(SESSION, MODEL);
    expect(consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now))
      .toEqual({ sessionID: SESSION, owner: OWNER, firstReceipt: true });
    expect(() => f.verifier.verify(pending, { model: MODEL })).toThrow("session has been deleted");
    expect(() => f.verifier.verify(f.issuer.signPrimaryRequest(SESSION, MODEL), { model: MODEL }))
      .toThrow("session has been deleted");
  });

  test("allows the identical signed transport retry, rejects a different notice or owner", () => {
    const f = fixture();
    expect(consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now).firstReceipt).toBe(true);
    expect(consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now).firstReceipt).toBe(false);
    const anotherNotice = signOpenCodeSessionDeletion(f.key, SESSION, OWNER, f.now);
    expect(() => consumeOpenCodeSessionDeletion(anotherNotice, f.key, f.verifier, f.now))
      .toThrow("already been deleted with another notice");
    const otherOwner = signOpenCodeSessionDeletion(f.key, SESSION, { ...OWNER, agent: "plan" }, f.now);
    expect(() => consumeOpenCodeSessionDeletion(otherOwner, f.key, f.verifier, f.now))
      .toThrow("already been deleted with another notice");
  });

  test("rejects forged, expired, future and active-owner-mismatched notices", () => {
    const f = fixture();
    const signed = f.issuer.signPrimaryRequest(SESSION, MODEL);
    f.verifier.verify(signed, { model: MODEL });
    // Corrupt a full 6-bit base64url char inside the HMAC. The final char of a
    // 32-byte signature carries only 4 data bits, so an A/B swap there can
    // decode to identical bytes and make this assertion randomly miss.
    const signatureStart = f.notice.lastIndexOf(".");
    const corruptAt = signatureStart + 10;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const originalChar = f.notice[corruptAt]!;
    const replacementChar = alphabet[(alphabet.indexOf(originalChar) + 1) % alphabet.length];
    const corrupted = f.notice.slice(0, corruptAt) + replacementChar + f.notice.slice(corruptAt + 1);
    expect(() => consumeOpenCodeSessionDeletion(corrupted, f.key, f.verifier, f.now))
      .toThrow("signature is invalid");
    expect(() => consumeOpenCodeSessionDeletion("not-a-notice", f.key, f.verifier, f.now))
      .toThrow("encoding is invalid");
    expect(() => consumeOpenCodeSessionDeletion(f.notice, randomBytes(32), f.verifier, f.now))
      .toThrow("signature is invalid");
    expect(() => consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now + 60_000))
      .toThrow("invalid or expired");
    expect(() => consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now - 5_001))
      .toThrow("invalid or expired");
    expect(() => consumeOpenCodeSessionDeletion(
      signOpenCodeSessionDeletion(f.key, SESSION, { ...OWNER, cwd: join(tmpdir(), "other-workspace") }, f.now),
      f.key, f.verifier, f.now,
    )).toThrow("owner does not match");
    // A rejected notice does not revoke the legitimate session.
    expect(f.verifier.verify(f.issuer.signPrimaryRequest(SESSION, MODEL), { model: MODEL }).sessionID)
      .toBe(SESSION);
  });

  test("deletion of an unseen session tombstones it before its first provider request", () => {
    const f = fixture();
    expect(consumeOpenCodeSessionDeletion(f.notice, f.key, f.verifier, f.now).firstReceipt).toBe(true);
    expect(() => f.verifier.verify(f.issuer.signPrimaryRequest(SESSION, MODEL), { model: MODEL }))
      .toThrow("session has been deleted");
  });

  test("requires a local, root-path HTTP bridge URL", () => {
    expect(localOpenCodeBridgeURL("http://127.0.0.1:17841/").port).toBe("17841");
    expect(localOpenCodeBridgeURL("http://localhost:17841/").hostname).toBe("localhost");
    expect(localOpenCodeBridgeURL("http://[::1]:17841/").hostname).toBe("[::1]");
    for (const url of ["not-a-url", "https://127.0.0.1/", "http://192.0.2.1/",
      "http://example.test/", "http://localhost/internal/", "http://localhost/?key=secret",
      "http://guest@localhost/", "http://localhost/#fragment"]) {
      expect(() => localOpenCodeBridgeURL(url)).toThrow();
    }
  });

  test("sender retries transient HTTP 5xx and network loss with the exact same notice", async () => {
    const f = fixture();
    const received: string[] = [];
    let attempts = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(OPENCODE_SESSION_DELETED_PATH);
      received.push(new Headers(init?.headers).get(OPENCODE_SESSION_DELETED_HEADER)!);
      attempts++;
      if (attempts === 1) throw new TypeError("socket closed");
      return new Response(null, { status: attempts === 2 ? 500 : 200 });
    }) as typeof fetch;
    await sendOpenCodeSessionDeletion("http://127.0.0.1:17841/", f.notice, fetcher);
    expect(attempts).toBe(3);
    expect(received).toEqual([f.notice, f.notice, f.notice]);
  });

  test("sender does not retry rejected 4xx and reports exhausted 5xx", async () => {
    let calls = 0;
    const reject = (async () => { calls++; return new Response(null, { status: 401 }); }) as unknown as typeof fetch;
    await expect(sendOpenCodeSessionDeletion("http://127.0.0.1/", "signed", reject))
      .rejects.toThrow("HTTP 401");
    expect(calls).toBe(1);
    calls = 0;
    const unavailable = (async () => { calls++; return new Response(null, { status: 503 }); }) as unknown as typeof fetch;
    await expect(sendOpenCodeSessionDeletion("http://127.0.0.1/", "signed", unavailable))
      .rejects.toThrow("HTTP 503");
    expect(calls).toBe(3);
  });
});

describe("OpenCode session deletion over the local Responses listener", () => {
  const serverFixture = () => {
    const key = randomBytes(32);
    const verifier = new OpenCodeTurnVerifier(key);
    const server = startServer({ ...defaultConfig("browser-only"), port: 0 }, {
      openCodeTurnVerifier: verifier, openCodeSessionDeletionKey: key,
    });
    const url = `http://127.0.0.1:${server.port}${OPENCODE_SESSION_DELETED_PATH}`;
    const send = (header?: string, headers: Record<string, string> = {}) => fetch(url, {
      method: "POST", headers: { ...(header ? { [OPENCODE_SESSION_DELETED_HEADER]: header } : {}), ...headers },
    });
    return { key, verifier, server, send };
  };

  test("blocks unsigned, forged and browser-Origin requests without consuming a valid notice", async () => {
    const f = serverFixture();
    try {
      const notice = signOpenCodeSessionDeletion(f.key, "ses_new_deleted_123", OWNER);
      expect((await f.send()).status).toBe(401);
      expect((await f.send("forged")).status).toBe(401);
      expect((await f.send(notice, { Origin: "http://malicious.example" })).status).toBe(403);
      const accepted = await f.send(notice);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        status: "ok", retired_session: "ses_new_deleted_123",
        retired_browser_turns: 0, cancelled_http_turns: 0,
      });
      expect((await f.send(notice)).status).toBe(200);
      expect((await f.send(signOpenCodeSessionDeletion(f.key, "ses_new_deleted_123", OWNER))).status).toBe(401);
    } finally { f.server.stop(true); }
  });

  test("duplicate requests wait for one physical retained-tab cleanup", async () => {
    const f = serverFixture();
    const sessionID = "ses_delete_browser_123";
    const conversationKey = randomBytes(32).toString("hex");
    let finishPhysical!: () => void;
    const physicalSettlement = new Promise<void>(resolve => { finishPhysical = resolve; });
    let releases = 0;
    chatGptTurnSessions.getOrCreate(`session-lifecycle-${conversationKey}`, () => ({
      mode: "read-only", browser: Promise.resolve("done"), physicalSettlement,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: { _openCodeTurn: { sessionID, owner: OWNER, compactionEpoch: 0 } } as unknown as CodexParsedRequest,
      conversationKey,
      releaseRetainedConversation: async () => { releases++; },
      cancel() {},
    }), undefined, `owner-${conversationKey}`, "msg_123456789", sessionID);
    try {
      const notice = signOpenCodeSessionDeletion(f.key, sessionID, OWNER);
      const first = f.send(notice);
      const second = f.send(notice);
      await Bun.sleep(10);
      expect(releases).toBe(0);
      finishPhysical();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((await a.json() as { retired_browser_turns: number }).retired_browser_turns).toBe(1);
      expect((await b.json() as { retired_browser_turns: number }).retired_browser_turns).toBe(1);
      expect(releases).toBe(1);
      expect(chatGptTurnSessions.findConversationHead(conversationKey)).toBeUndefined();
    } finally {
      finishPhysical();
      f.server.stop(true);
    }
  });

  test("failed physical cleanup returns an error on both original and identical retry", async () => {
    const f = serverFixture();
    const sessionID = "ses_failed_release_123";
    const conversationKey = randomBytes(32).toString("hex");
    let releases = 0;
    const issuer = new OpenCodeTurnIssuer(f.key);
    issuer.beginPrompt(sessionID, "msg_123456789");
    issuer.observeContext(sessionID, MODEL, TOOLS, OWNER);
    const pendingTurn = issuer.signPrimaryRequest(sessionID, MODEL);
    f.verifier.verify(pendingTurn, { model: MODEL });
    chatGptTurnSessions.getOrCreate(`session-lifecycle-${conversationKey}`, () => ({
      mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: { _openCodeTurn: { sessionID, owner: OWNER, compactionEpoch: 0 } } as unknown as CodexParsedRequest,
      conversationKey,
      releaseRetainedConversation: async () => { releases++; throw new Error("simulated release failure"); },
      cancel() {},
    }), undefined, `owner-${conversationKey}`, "msg_123456789", sessionID);
    try {
      const notice = signOpenCodeSessionDeletion(f.key, sessionID, OWNER);
      const original = await f.send(notice);
      const retry = await f.send(notice);
      expect(original.status).toBe(500);
      expect(retry.status).toBe(500);
      expect(releases).toBe(1);
      expect(() => f.verifier.verify(issuer.signPrimaryRequest(sessionID, MODEL), { model: MODEL }))
        .toThrow("session has been deleted");
      expect((await retry.json() as { error: string }).error).toContain("cleanup failed");
    } finally { f.server.stop(true); }
  });
});
