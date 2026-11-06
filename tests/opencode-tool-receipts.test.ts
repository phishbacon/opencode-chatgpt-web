/**
 * Codex's original native rollout and TurnBroker reconcile the browser's tool
 * calls with native tool responses. OpenCode instead needs bridge-issued tool
 * receipts to validate its own native function_call_output history without
 * trusting caller-authored Responses items or replacing OpenCode permissions.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  OpenCodeTurnIssuer, OpenCodeTurnVerifier,
  type OpenCodeTurnClaims,
} from "../src/opencode/turn-binding";
import { OpenCodeToolReceiptLedger } from "../src/opencode/tool-receipts";

const MODEL = "opencode-chatgpt-web/light";
const SESSION = "ses_123456789";
const CONTEXT = {
  shell: { description: "Run command", input: { type: "object", properties: { command: { type: "string" } } } },
  read: { description: "Read file", input: { type: "object", properties: { path: { type: "string" } } } },
};
const WIRE = Object.entries(CONTEXT).map(([name, data]) => ({
  type: "function", name, description: data.description, parameters: data.input, strict: false,
}));
const OWNER = { cwd: "/tmp/example-workspace", projectID: "pro_123456789", agent: "build" };
const CALLS = [
  { callId: "call_alpha", name: "shell", arguments: '{"command":"echo ok"}' },
  { callId: "call_beta", name: "read", arguments: '{"path":"/tmp/fixture"}' },
];

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
    expect(() => f.ledger.validateContinuation(owner, "unrelated prompt")).toThrow("outstanding tool batch is absent");
    f.ledger.validateContinuation(owner, history);
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
    expect(() => f.ledger.validateContinuation(f.claims(), history)).toThrow("previous turn still has outstanding");
    f.ledger.validateContinuation(owner, history);
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

  test("compaction cannot discard outstanding calls or invent canonical history", () => {
    const f = harness();
    const first = f.claims();
    f.ledger.issueBatch(first, WIRE, CALLS);
    f.issuer.noteCompaction(SESSION);
    const next = f.claims();
    expect(() => f.ledger.validateContinuation(next, "summary string"))
      .toThrow("compaction requires canonical native tool history");
    expect(() => f.ledger.validateContinuation(next, []))
      .toThrow("parallel tool batch has missing");
    expect(() => f.ledger.validateContinuation(next, history.filter(item => !('call_id' in item)
      || item.call_id === "call_beta"))).toThrow("parallel tool batch has missing");
    // Compaction changes only after both native tool results are reconciled.
    f.ledger.validateContinuation(next, history);
    f.ledger.issueBatch(next, WIRE, [{ callId: "call_gamma", name: "read", arguments: "{}" }]);
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
});
