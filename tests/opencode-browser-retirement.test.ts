/**
 * Codex's original harness closes retained ChatGPT browser conversations from
 * its native compaction handoff. OpenCode closes earlier browser epochs after
 * a verified signed compaction generation reaches the shared adapter. These
 * tests exercise that lifecycle without starting OpenCode or a real browser.
 */
import { expect, test } from "bun:test";
import {
  ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import type { CodexParsedRequest } from "../src/types";
import type { OpenCodeTurnOwner } from "../src/opencode/turn-binding";

const SESSION = "ses_123456789";
const OWNER = "verified-opencode-owner";
const TRUSTED_OWNER: OpenCodeTurnOwner = {
  cwd: "/tmp/example-workspace", projectID: "pro_123456789", agent: "build",
};

function epochInput(epoch: number): CodexParsedRequest {
  return { _openCodeTurn: { compactionEpoch: epoch } } as unknown as CodexParsedRequest;
}

test("OpenCode compaction waits for old work to settle, releases one old tab and keeps other owners", async () => {
  const sessions = new ChatGptTurnSessions();
  const oldKey = "a".repeat(64);
  const currentKey = "b".repeat(64);
  const otherKey = "c".repeat(64);
  let settleBrowser!: (answer: string) => void;
  let settlePhysical!: () => void;
  const browser = new Promise<string>(resolve => { settleBrowser = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  const released: string[] = [];
  let cancelled = 0;
  const add = (key: string, conversationKey: string, epoch: number, ownerKey: string, sessionID: string,
    browserTask: Promise<string> = Promise.resolve("done"), physical: Promise<void> = Promise.resolve()) => (
    sessions.getOrCreate(key, () => ({
      mode: "read-only", browser: browserTask, physicalSettlement: physical,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: epochInput(epoch), conversationKey,
      releaseRetainedConversation: async () => { released.push(conversationKey); },
      cancel: () => { cancelled += 1; },
    }), undefined, ownerKey, "msg_123456789", sessionID)
  );
  add("old", oldKey, 0, OWNER, SESSION, browser, physicalSettlement);
  add("current", currentKey, 1, OWNER, SESSION);
  add("other", otherKey, 0, "unrelated-owner", "ses_987654321");

  const retirement = sessions.retireEarlierOpenCodeEpochsAndWait(OWNER, SESSION, 1);
  await Bun.sleep(0);
  expect(released).toEqual([]);
  expect(cancelled).toBe(0);
  settleBrowser("done");
  await Bun.sleep(0);
  expect(released).toEqual([]);
  settlePhysical();
  expect(await retirement).toBe(1);
  expect(released).toEqual([oldKey]);
  expect(sessions.find("old")).toBeUndefined();
  expect(sessions.find("current")).toBeDefined();
  expect(sessions.find("other")).toBeDefined();
  expect(await sessions.retireEarlierOpenCodeEpochsAndWait(OWNER, SESSION, 1)).toBe(0);
  sessions.clear();
});

test("OpenCode compaction retires the in-flight pre-compaction browser without waiting for it", async () => {
  const sessions = new ChatGptTurnSessions();
  const reasons: string[] = [];
  const add = (key: string, conversationKey: string, ownerKey: string, sessionID: string,
    browserTask: Promise<string>) => (
    sessions.getOrCreate(key, () => ({
      mode: "read-only", browser: browserTask, physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: epochInput(0), conversationKey,
      releaseRetainedConversation: async () => {},
      cancel: (reason?: Error) => { reasons.push(reason?.message ?? ""); },
    }), undefined, ownerKey, "msg_123456789", sessionID)
  );

  // The in-flight browser never settles: retiring it must not wait on it, or the
  // compaction request would queue behind the very turn only compaction can end.
  const neverSettles = new Promise<string>(() => {});
  add("d".repeat(64), "d".repeat(64), OWNER, SESSION, neverSettles);
  add("e".repeat(64), "e".repeat(64), OWNER, "ses_987654321", Promise.resolve("done"));
  add("f".repeat(64), "f".repeat(64), "unrelated-owner", SESSION, Promise.resolve("done"));

  expect(await sessions.retireOpenCodeSessionAndWait(OWNER, SESSION)).toBe(1);
  expect(reasons).toEqual(["OpenCode compaction retired this pre-compaction ChatGPT response."]);
  expect(sessions.find("d".repeat(64))).toBeUndefined();
  expect(sessions.find("e".repeat(64))).toBeDefined();
  expect(sessions.find("f".repeat(64))).toBeDefined();
  expect(await sessions.retireOpenCodeSessionAndWait(OWNER, SESSION)).toBe(0);
  sessions.clear();
});

test("OpenCode browser retirement rejects an older epoch and preserves its retained tab", async () => {
  const sessions = new ChatGptTurnSessions();
  const key = "d".repeat(64);
  const session = sessions.getOrCreate("future", () => ({
    mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: epochInput(3), conversationKey: key,
    releaseRetainedConversation: async () => { throw new Error("unexpected browser release"); },
    cancel() {},
  }), undefined, OWNER, "msg_123456789", SESSION);
  await expect(sessions.retireEarlierOpenCodeEpochsAndWait(OWNER, SESSION, 2))
    .rejects.toThrow("cannot roll back");
  expect(sessions.findConversationHead(key)).toBe(session);
  sessions.clear();
});

test("retirement registers owner settlement before a concurrent replacement begins", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishRelease!: () => void;
  const release = new Promise<void>(resolve => { finishRelease = resolve; });
  const conversationKey = "e".repeat(64);
  sessions.getOrCreate("old", () => ({
    mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: epochInput(0), conversationKey,
    releaseRetainedConversation: () => release,
    cancel() {},
  }), undefined, OWNER, "msg_123456789", SESSION);
  const retirement = sessions.retireEarlierOpenCodeEpochsAndWait(OWNER, SESSION, 1);
  await Bun.sleep(0);
  let started = false;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("replacement", OWNER, () => {
    started = true;
    return {
      mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: epochInput(1), conversationKey: "f".repeat(64), cancel() {},
    };
  });
  await Bun.sleep(0);
  expect(started).toBe(false);
  finishRelease();
  expect(await retirement).toBe(1);
  await replacement;
  expect(started).toBe(true);
  sessions.clear();
});

test("deleting an active OpenCode session waits for its physical tab close and preserves another session", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishBrowser!: (answer: string) => void;
  let finishPhysical!: () => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  const physical = new Promise<void>(resolve => { finishPhysical = resolve; });
  const closed: string[] = [];
  const cancelled: string[] = [];
  const add = (key: string, sessionID: string, browserTask: Promise<string>, physicalTask: Promise<void>) => {
    sessions.getOrCreate(key, () => ({
      mode: "read-only", browser: browserTask, physicalSettlement: physicalTask,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: { _openCodeTurn: { sessionID, owner: TRUSTED_OWNER, compactionEpoch: 0 } } as CodexParsedRequest,
      conversationKey: key.repeat(64),
      releaseRetainedConversation: async () => { closed.push(key); },
      cancel: () => { cancelled.push(key); },
    }), undefined, `owner-${sessionID}`, "msg_123456789", sessionID);
  };
  add("a", SESSION, browser, physical);
  add("b", "ses_other_owner_123", Promise.resolve("finished"), Promise.resolve());
  const retirement = sessions.retireDeletedOpenCodeSessionAndWait(SESSION, TRUSTED_OWNER);
  await Bun.sleep(0);
  expect(cancelled).toEqual(["a"]);
  expect(closed).toEqual([]);
  expect(sessions.findConversationHead("b".repeat(64))).toBeDefined();
  finishBrowser("done");
  await Bun.sleep(0);
  expect(closed).toEqual([]);
  finishPhysical();
  expect(await retirement).toBe(1);
  expect(closed).toEqual(["a"]);
  expect(sessions.findConversationHead("a".repeat(64))).toBeUndefined();
  expect(sessions.findConversationHead("b".repeat(64))).toBeDefined();
  sessions.clear();
});

test("refuses deletion if one retained conversation has another OpenCode owner", async () => {
  const sessions = new ChatGptTurnSessions();
  const shared = "z".repeat(64);
  const closed: string[] = [];
  for (const sessionID of [SESSION, "ses_other_owner_123"]) {
    sessions.getOrCreate(sessionID, () => ({
      mode: "read-only", browser: Promise.resolve("done"), physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: { _openCodeTurn: { sessionID, owner: TRUSTED_OWNER, compactionEpoch: 0 } } as CodexParsedRequest,
      conversationKey: shared,
      releaseRetainedConversation: async () => { closed.push(sessionID); },
      cancel() {},
    }), undefined, `owner-${sessionID}`, "msg_123456789", sessionID);
  }
  await expect(sessions.retireDeletedOpenCodeSessionAndWait(SESSION, TRUSTED_OWNER))
    .rejects.toThrow("another session owner");
  expect(closed).toEqual([]);
  expect(sessions.find(SESSION)).toBeDefined();
  expect(sessions.find("ses_other_owner_123")).toBeDefined();
  sessions.clear();
});
