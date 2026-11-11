/**
 * Codex's original native rollout and TurnBroker reconcile the browser's tool
 * calls with native tool responses. OpenCode instead needs bridge-issued tool
 * receipts to validate its own native function_call_output history without
 * trusting caller-authored Responses items or replacing OpenCode permissions.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  OpenCodeTurnIssuer, OpenCodeTurnVerifier,
  type OpenCodeTurnClaims,
} from "../src/opencode/turn-binding";
import { OpenCodeToolReceiptLedger } from "../src/opencode/tool-receipts";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

const MODEL = "opencode-chatgpt-web/light";
const SESSION = "ses_123456789";
const CONTEXT = {
  shell: { description: "Run command", input: { type: "object", properties: { command: { type: "string" } } } },
  read: { description: "Read file", input: { type: "object", properties: { path: { type: "string" } } } },
};
const WIRE = Object.entries(CONTEXT).map(([name, data]) => ({
  type: "function", name, description: data.description, parameters: data.input, strict: false,
}));
const OWNER = { cwd: join(tmpdir(), "example-workspace"), projectID: "pro_123456789", agent: "build" };
const CALLS = [
  { callId: "call_alpha", name: "shell", arguments: '{"command":"echo ok"}' },
  { callId: "call_beta", name: "read", arguments: '{"path":"/tmp/fixture"}' },
];

/** Receipt-gap failures must carry the wire type that makes OpenCode compact, not authenticate. */
function capturedError(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a receipt gap failure");
}

const history = [
  { type: "message", role: "user", content: "Inspect the fixture" },
  { type: "function_call", call_id: "call_alpha", name: "shell", arguments: '{"command":"echo ok"}' },
  { type: "function_call", call_id: "call_beta", name: "read", arguments: '{"path":"/tmp/fixture"}' },
  { type: "function_call_output", call_id: "call_beta", output: "fixture contents" },
  { type: "function_call_output", call_id: "call_alpha", output: "ok" },
] as const;

function harness() {
  const key = randomBytes(32);
  const issuer = new OpenCodeTurnIssuer(key);
  const verifier = new OpenCodeTurnVerifier(key);
  const ledger = new OpenCodeToolReceiptLedger();
  const begin = (sessionID = SESSION, messageID = "msg_123456789") => {
    issuer.beginPrompt(sessionID, messageID);
    issuer.observeContext(sessionID, MODEL, CONTEXT, OWNER);
  };
  const claims = (sessionID = SESSION): OpenCodeTurnClaims => verifier.verify(
    issuer.signPrimaryRequest(sessionID, MODEL), { model: MODEL }, { consume: false },
  );
  begin();
  return { ledger, issuer, verifier, begin, claims };
}

describe("OpenCode website tool receipt ledger", () => {
  test("authenticates a parallel batch and accepts canonical completed history in later requests", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    f.ledger.validateContinuation(owner, history, { consume: false });
    f.ledger.validateContinuation(owner, history);
    // OpenCode may resend complete native history in the next provider round.
    f.ledger.validateContinuation(f.claims(), history);
    f.begin(SESSION, "msg_nextturn123");
    f.ledger.validateContinuation(f.claims(), history);
    // Security rejections keep the authentication channel: only receipt gaps
    // (whose designed remedy is compaction) may claim a context failure.
    const forgedHistory = [...history, { type: "function_call", call_id: "call_ghost", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_ghost", output: "ghost" }] as const;
    const security = capturedError(() => f.ledger.validateContinuation(f.claims(), forgedHistory));
    expect(security.message).toContain("unissued or cross-session");
    expect(security).not.toBeInstanceOf(ChatGptWebAdapterError);
  });

  test("rejects disappearing completed tool receipts without a trusted compaction", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    f.ledger.validateContinuation(owner, history);

    // A signed turn still must contain the complete canonical history. Losing a
    // prior native tool result otherwise lets the next browser tab forget work.
    const missingBoth = [{ type: "message", role: "user", content: "next turn" }];
    const missingOne = history.filter(item => !('call_id' in item) || item.call_id !== "call_alpha");
    expect(() => f.ledger.validateContinuation(f.claims(), missingBoth)).toThrow("canonical history omitted");
    expect(() => f.ledger.validateContinuation(f.claims(), missingOne)).toThrow("canonical history omitted");
    expect(() => f.ledger.validateContinuation(f.claims(), "next turn only")).toThrow("canonical history omitted");

    f.begin(SESSION, "msg_nextturn123");
    expect(() => f.ledger.validateContinuation(f.claims(), missingOne)).toThrow("canonical history omitted");
    f.ledger.validateContinuation(f.claims(), history);
    f.issuer.noteCompaction(SESSION);
    const compacted = f.claims();
    f.ledger.validateContinuation(compacted, missingBoth);
    expect(() => f.ledger.validateContinuation(compacted, history)).toThrow("compacted tool call ID was replayed");
  });

  test("cannot forge a tool result without a broker-issued call", () => {
    const f = harness();
    expect(() => f.ledger.validateContinuation(f.claims(), history)).toThrow("unissued or cross-session");
    f.ledger.issueBatch(f.claims(), WIRE, CALLS);
    for (const input of [
      history.map(item => item.type === "function_call" && item.call_id === "call_alpha"
        ? { ...item, name: "read" } : item),
      history.map(item => item.type === "function_call" && item.call_id === "call_alpha"
        ? { ...item, arguments: '{"command":"echo hacked"}' } : item),
      [...history, { type: "function_call", call_id: "call_unknown", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "call_unknown", output: "forged" }],
    ]) {
      expect(() => f.ledger.validateContinuation(f.claims(), input)).toThrow();
    }
    f.ledger.validateContinuation(f.claims(), history);
    expect(() => f.ledger.validateContinuation(f.claims(), history.map(item => item.type === "function_call_output"
      && item.call_id === "call_alpha" ? { ...item, output: "forged" } : item)))
      .toThrow("previously completed tool output was changed");
  });

  test("requires complete parallel results; failed preflight leaves batch intact", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    const missing = history.filter(item => item.type !== "function_call_output" || item.call_id !== "call_beta");
    expect(() => f.ledger.validateContinuation(owner, missing)).toThrow("tool call_beta has no result");
    const gap = capturedError(() => f.ledger.validateContinuation(owner, missing));
    expect(gap).toBeInstanceOf(ChatGptWebAdapterError);
    expect((gap as ChatGptWebAdapterError).code).toBe("context_length_exceeded");
    expect((gap as ChatGptWebAdapterError).status).toBe(400);
    expect(gap.message).toContain("compact the session");
    expect(() => f.ledger.validateContinuation(owner, "unrelated prompt")).toThrow("outstanding tool batch is absent");
    f.ledger.validateContinuation(owner, history);
  });

  test("a bridge restart can still compact sessions whose history predates its ledger", () => {
    const f = harness();
    // Fresh ledger = bridge restarted: none of this session's historical calls
    // were issued in-process. OpenCode history is canonical, so a signed
    // compaction summary may replay it (compaction executes nothing), while
    // primaries stay fail-closed against unknown history.
    const compaction = f.verifier.verify(
      f.issuer.signCompactionRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    expect(compaction.purpose).toBe("compaction");
    f.ledger.validateContinuation(compaction, history);
    f.ledger.validateContinuation(compaction, history, { consume: false });
    expect(() => f.ledger.validateContinuation(f.claims(), history))
      .toThrow("unissued or cross-session tool call");
  });

  test("rejects duplicate tool IDs, unauthorized tool names and malformed arguments without partially issuing", () => {
    const f = harness();
    const owner = f.claims();
    for (const batch of [
      [CALLS[0]!, CALLS[0]!],
      [CALLS[0]!, { callId: "call_new", name: "not-in-inventory", arguments: "{}" }],
      [CALLS[0]!, { callId: "call_new", name: "read", arguments: "not-json" }],
    ]) expect(() => f.ledger.issueBatch(owner, WIRE, batch)).toThrow();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    expect(() => f.ledger.issueBatch(owner, WIRE, [CALLS[0]!])).toThrow("previous tool batch still has outstanding");
    f.ledger.validateContinuation(owner, history);
    expect(() => f.ledger.issueBatch(owner, WIRE, [CALLS[0]!])).toThrow("already been issued");
  });

  test("rejects other sessions, superseded turns and modified tool inventories", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    f.begin("ses_other123", "msg_other123");
    expect(() => f.ledger.validateContinuation(f.claims("ses_other123"), history)).toThrow("unissued or cross-session");
    f.begin(SESSION, "msg_nextturn123");
    // A later turn resolves the dead turn's outstanding results from its
    // canonical history instead of wedging the session forever: issuance and
    // call identity are already proven, OpenCode history is canonical.
    f.ledger.validateContinuation(f.claims(), history);
    // The dead turn itself may no longer continue.
    expect(() => f.ledger.validateContinuation(owner, history)).toThrow("superseded turn");
    const next = f.claims();
    f.ledger.validateContinuation(next, history);
    f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: '{"path":"/tmp/new"}' }]);
    const changed = { ...next, toolsHash: "f".repeat(64) };
    expect(() => f.ledger.validateContinuation(changed, [
      ...history,
      { type: "function_call", call_id: "call_gamma", name: "read", arguments: '{"path":"/tmp/new"}' },
      { type: "function_call_output", call_id: "call_gamma", output: "new contents" },
    ])).toThrow("different turn or inventory");
    f.ledger.retireSession(SESSION);
    expect(() => f.ledger.validateContinuation(next, history)).toThrow("unissued or cross-session");
  });

  test("a later turn resolves a dead turn's outstanding batch from canonical history", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    // The issuing turn dies before its continuation arrives (tool timeout,
    // crash, or a rejected request): its results never reached the bridge.
    f.begin(SESSION, "msg_aftercrash12");
    f.ledger.validateContinuation(f.claims(), history);
    // Results are pinned from canonical history; tampering is rejected after.
    expect(() => f.ledger.validateContinuation(f.claims(), history.map(item =>
      item.type === "function_call_output" && item.call_id === "call_alpha"
        ? { ...item, output: "forged" } : item)))
      .toThrow("previously completed tool output was changed");
    // The session is unwedged: the next batch issues normally.
    f.ledger.issueBatch(f.claims(), WIRE, [{ callId: "call_gamma", name: "read", arguments: '{"path":"/tmp/next"}' }]);
  });

  test("stays fail-closed when a later turn omits the outstanding results", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    f.begin(SESSION, "msg_noresults12");
    const later = f.claims();
    // Tool history without the pending results cannot resolve the batch.
    expect(() => f.ledger.validateContinuation(later, [{ type: "message", role: "user", content: "next turn" }]))
      .toThrow("parallel tool batch has missing");
    // A pending call whose result is stripped still fails closed.
    expect(() => f.ledger.validateContinuation(later, history.filter(item =>
      !(item.type === "function_call_output" && item.call_id === "call_alpha"))))
      .toThrow("tool call_alpha has no result");
    // Non-array input cannot reconcile outstanding receipts at all.
    expect(() => f.ledger.validateContinuation(later, "plain prompt"))
      .toThrow("canonical history omitted");
  });

  test("trusted compaction retires omitted completed calls while preserving retained receipts", () => {
    const f = harness();
    const first = f.claims();
    f.ledger.issueBatch(first, WIRE, CALLS);
    f.ledger.validateContinuation(first, history);
    f.issuer.noteCompaction(SESSION);
    const next = f.claims();
    expect(next.compactionEpoch).toBe(1);
    expect(() => f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: "{}" }]))
      .toThrow("compaction epoch must be validated");
    const retained = history.filter(item => !('call_id' in item) || item.call_id === "call_beta");
    f.ledger.validateContinuation(next, retained, { consume: false });
    // Readiness checks do not prune the ledger or advance the epoch.
    expect(() => f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: "{}" }]))
      .toThrow("compaction epoch must be validated");
    f.ledger.validateContinuation(next, retained);
    expect(() => f.ledger.validateContinuation(next, history)).toThrow("compacted tool call ID was replayed");
    expect(() => f.ledger.issueBatch(next, WIRE, [{ ...CALLS[0]! }]))
      .toThrow("already been issued");
    expect(() => f.ledger.validateContinuation(next, retained.map(item => item.type === "function_call_output"
      ? { ...item, output: "forged" } : item))).toThrow("previously completed tool output was changed");
    f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: '{"path":"/tmp/new"}' }]);
    f.ledger.validateContinuation(next, [
      ...retained,
      { type: "function_call", call_id: "call_gamma", name: "read", arguments: '{"path":"/tmp/new"}' },
      { type: "function_call_output", call_id: "call_gamma", output: "new" },
    ]);
    expect(() => f.ledger.validateContinuation(first, retained)).toThrow("earlier compaction epoch");
  });

  test("the compaction boundary commits present results and retires absent ones instead of wedging", () => {
    const f = harness();
    const first = f.claims();
    f.ledger.issueBatch(first, WIRE, CALLS);
    f.issuer.noteCompaction(SESSION);
    const next = f.claims();
    expect(next.compactionEpoch).toBe(1);
    // Retirement still requires canonical tool history: a body that carries none
    // cannot advance the epoch on its own.
    expect(() => f.ledger.validateContinuation(next, "summary string"))
      .toThrow("compaction requires canonical native tool history");
    // Partial canonical history at the boundary: the result it carries commits,
    // the call it no longer contains retires — the session never wedges.
    const partial = history.filter(item => !('call_id' in item) || item.call_id !== "call_beta");
    f.ledger.validateContinuation(next, partial, { consume: false });
    f.ledger.validateContinuation(next, partial);
    expect(f.ledger.sessionEpochs()[SESSION]).toBe(1);
    // The retired call ID can never come back, issued or not.
    expect(() => f.ledger.validateContinuation(next, history))
      .toThrow("compacted tool call ID was replayed");
    f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: "{}" }]);
    f.ledger.validateContinuation(next, [
      ...partial,
      { type: "function_call", call_id: "call_gamma", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_gamma", output: "ok" },
    ]);
  });

  test("a compaction body may omit receipts; the epoch boundary reconciles them", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    const compaction = f.verifier.verify(
      f.issuer.signCompactionRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    expect(compaction.purpose).toBe("compaction");
    expect(compaction.compactionEpoch).toBe(0);
    // OpenCode renders the summarization request as the budget allows: full
    // transcript, kept tail dropped, or flattened to text. None of those is a
    // continuation, so an empty rendering neither fails nor reconciles here.
    f.ledger.validateContinuation(compaction, []);
    expect(f.ledger.sessionEpochs()[SESSION]).toBe(0);
    // A normal turn still fails closed on the missing results.
    f.begin(SESSION, "msg_afterrender1");
    expect(() => f.ledger.validateContinuation(f.claims(), [{ type: "message", role: "user", content: "next" }]))
      .toThrow("parallel tool batch has missing");
    // The first post-compaction request carries the real new history: present
    // results commit, absent ones would retire at the boundary.
    f.issuer.noteCompaction(SESSION);
    const next = f.claims();
    expect(next.compactionEpoch).toBe(1);
    f.ledger.validateContinuation(next, history);
    expect(f.ledger.sessionEpochs()[SESSION]).toBe(1);
    f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: '{"path":"/tmp/next"}' }]);
  });

  test("compaction can retire all completed receipts but cannot resurrect their IDs", () => {
    const f = harness();
    const first = f.claims();
    f.ledger.issueBatch(first, WIRE, CALLS);
    f.ledger.validateContinuation(first, history);
    f.issuer.noteCompaction(SESSION);
    const next = f.claims();
    expect(() => f.ledger.validateContinuation(next, "new summary"))
      .toThrow("compaction requires canonical native tool history");
    f.ledger.validateContinuation(next, [{ type: "message", role: "user", content: "compacted summary" }]);
    expect(() => f.ledger.issueBatch(next, WIRE, [CALLS[1]!])).toThrow("already been issued");
    expect(() => f.ledger.validateContinuation(next, history)).toThrow("compacted tool call ID was replayed");
  });

  test("persists receipts across a bridge restart so retained history stays verifiable", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "oc-receipts-")), "tool-receipts.json");
    const key = randomBytes(32);
    let now = 1_800_000_000_000;
    const clock = () => now;

    // Bridge process one: issue the batch and complete the turn.
    const issuerA = new OpenCodeTurnIssuer(key, clock);
    issuerA.beginPrompt(SESSION, "msg_persist123");
    issuerA.observeContext(SESSION, MODEL, CONTEXT, OWNER);
    const ledgerA = new OpenCodeToolReceiptLedger(statePath);
    const claimsA = new OpenCodeTurnVerifier(key, clock).verify(
      issuerA.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    ledgerA.issueBatch(claimsA, WIRE, CALLS);
    ledgerA.validateContinuation(claimsA, history);
    expect(readFileSync(statePath, "utf8")).toContain("call_alpha");

    // Bridge process two (restart): fresh in-memory maps, same state file.
    now += 60_000;
    const ledgerB = new OpenCodeToolReceiptLedger(statePath);
    const issuerB = new OpenCodeTurnIssuer(key, clock);
    issuerB.beginPrompt(SESSION, "msg_persist456");
    issuerB.observeContext(SESSION, MODEL, CONTEXT, OWNER);
    const claimsB = new OpenCodeTurnVerifier(key, clock).verify(
      issuerB.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    expect(() => ledgerB.validateContinuation(claimsB, history)).not.toThrow();

    // Persisted output hashes still reject edited history.
    now += 60_000;
    const tampered = history.map(item => (item as { call_id?: string }).call_id === "call_alpha" && item.type === "function_call_output"
      ? { ...item, output: "forged" } : item);
    issuerB.beginPrompt(SESSION, "msg_persist789");
    issuerB.observeContext(SESSION, MODEL, CONTEXT, OWNER);
    const claimsC = new OpenCodeTurnVerifier(key, clock).verify(
      issuerB.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    expect(() => ledgerB.validateContinuation(claimsC, tampered)).toThrow("previously completed tool output was changed");

    // Cross-session history stays rejected after reload.
    now += 60_000;
    const otherIssuer = new OpenCodeTurnIssuer(key, clock);
    otherIssuer.beginPrompt("ses_other999", "msg_other123");
    otherIssuer.observeContext("ses_other999", MODEL, CONTEXT, OWNER);
    const otherClaims = new OpenCodeTurnVerifier(key, clock).verify(
      otherIssuer.signPrimaryRequest("ses_other999", MODEL), { model: MODEL }, { consume: false },
    );
    expect(() => ledgerB.validateContinuation(otherClaims, history)).toThrow("unissued or cross-session");
  });

  test("exposes durable session epochs for the signer's healthz sync", () => {
    const f = harness();
    const owner = f.claims();
    f.ledger.issueBatch(owner, WIRE, CALLS);
    f.ledger.validateContinuation(owner, history);
    expect(f.ledger.sessionEpochs()[SESSION]).toBe(0);

    f.begin(SESSION, "msg_epochnext12");
    f.issuer.noteCompaction(SESSION);
    const compacted = f.claims();
    expect(compacted.purpose).toBeUndefined(); // claims helper signs primaries; epoch is what matters
    f.ledger.validateContinuation(compacted, history);
    expect(f.ledger.sessionEpochs()[SESSION]).toBe(1);
  });

  test("corrupt receipt state fails closed as an empty ledger", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "oc-receipts-bad-")), "tool-receipts.json");
    writeFileSync(statePath, "{corrupt");
    const key = randomBytes(32);
    const ledger = new OpenCodeToolReceiptLedger(statePath);
    const issuer = new OpenCodeTurnIssuer(key);
    issuer.beginPrompt(SESSION, "msg_corrupt12");
    issuer.observeContext(SESSION, MODEL, CONTEXT, OWNER);
    const claims = new OpenCodeTurnVerifier(key).verify(
      issuer.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false },
    );
    expect(() => ledger.validateContinuation(claims, history)).toThrow("unissued or cross-session");
  });
});
