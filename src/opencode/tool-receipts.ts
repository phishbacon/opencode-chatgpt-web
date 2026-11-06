/**
 * The original Codex harness reconciles tool results against calls emitted by
 * its native rollout and held by the TurnBroker. OpenCode has no Codex rollout:
 * its website broker must register each emitted call here before OpenCode's
 * native harness can return that call's result through Responses. The ledger
 * belongs to the bridge process, never to caller-supplied request history.
 * It proves issuance and exact continuation; OpenCode still executes tools and
 * enforces its own permissions. No browser or client may register receipts.
 */
import { createHash } from "node:crypto";
import { OpenCodeTurnBindingError, hashOpenCodeWireTools, type OpenCodeTurnClaims } from "./turn-binding";

interface IssuedCall {
  callId: string;
  name: string;
  argsHash: string;
  sessionID: string;
  turnNonce: string;
  ownerKey: string;
  model: string;
  toolsHash: string;
  outputHash?: string;
}

interface SessionReceipts {
  ownerKey: string;
  turnNonce: string;
  started: number;
  compactionEpoch: number;
  calls: Set<string>;
  /** Remember compacted IDs so an old browser call cannot be issued again. */
  retiredIds: Set<string>;
}

export interface OpenCodeIssuedToolCall {
  callId: string;
  name: string;
  arguments: string;
}

const MAX_CALLS = 4096;
const MAX_CALLS_PER_SESSION = 512;
const MAX_RETIRED_IDS_PER_SESSION = 16_384;
const MAX_BATCH_SIZE = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CALL_ID = /^[\w.-]{1,256}$/;
const TOOL_NAME = /^[\w.-]{1,160}$/;

function fail(detail: string): never {
  throw new OpenCodeTurnBindingError(`OpenCode broker receipt: ${detail}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) fail("tool value nesting exceeds limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(v => canonical(v, depth + 1));
  if (record(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1);
    return result;
  }
  return fail("tool value must be valid JSON");
}

function digest(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(canonical(value));
  if (json === undefined || Buffer.byteLength(json) > maxBytes) fail("tool value exceeds size limit");
  return createHash("sha256").update(json).digest("hex");
}

function argumentsHash(raw: unknown): string {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_ARGUMENT_BYTES) fail("tool arguments must be bounded JSON text");
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "{}"); }
  catch { return fail("tool arguments must be valid JSON"); }
  if (!record(parsed)) fail("tool arguments must be an object");
  return digest(parsed, MAX_ARGUMENT_BYTES);
}

function ownerKey(claims: OpenCodeTurnClaims): string {
  return JSON.stringify([claims.owner.cwd, claims.owner.projectID, claims.owner.agent]);
}

/** Register calls only after the trusted website broker issues them to OpenCode. */
export class OpenCodeToolReceiptLedger {
  private readonly calls = new Map<string, IssuedCall>();
  private readonly sessions = new Map<string, SessionReceipts>();

  issueBatch(claims: OpenCodeTurnClaims, wireTools: unknown, batch: readonly OpenCodeIssuedToolCall[]): void {
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_SIZE) fail("invalid issued tool batch");
    if (hashOpenCodeWireTools(wireTools) !== claims.toolsHash) fail("tool inventory differs from trusted OpenCode context");
    const available = new Set((wireTools as { name: string }[]).map(tool => tool.name));
    const active = this.sessions.get(claims.sessionID);
    const owner = ownerKey(claims);
    if (active && active.ownerKey !== owner) fail("session owner changed");
    if (active && active.compactionEpoch !== claims.compactionEpoch) {
      fail("compaction epoch must be validated against canonical history before issuing tools");
    }
    if (active && (active.turnNonce !== claims.turnNonce || claims.turnStarted !== active.started)
      && claims.turnStarted <= active.started) fail("superseded turn cannot issue tools");
    if (active && [...active.calls].some(id => this.calls.get(id)?.outputHash === undefined)) {
      fail("previous tool batch still has outstanding calls");
    }
    if (this.calls.size + batch.length > MAX_CALLS || (active?.calls.size ?? 0) + batch.length > MAX_CALLS_PER_SESSION) {
      fail("receipt capacity exceeded; session cleanup required");
    }
    const ids = new Set<string>();
    const entries = batch.map(call => {
      if (!CALL_ID.test(call.callId) || !TOOL_NAME.test(call.name) || !available.has(call.name)) {
        fail("broker-issued tool is outside trusted inventory or has invalid identity");
      }
      if (ids.has(call.callId) || this.calls.has(call.callId) || active?.retiredIds.has(call.callId)) {
        fail("tool call ID has already been issued");
      }
      ids.add(call.callId);
      return {
        callId: call.callId, name: call.name, argsHash: argumentsHash(call.arguments),
        sessionID: claims.sessionID, turnNonce: claims.turnNonce, ownerKey: owner,
        model: claims.model, toolsHash: claims.toolsHash,
      } satisfies IssuedCall;
    });
    // All checks completed before changing state: parallel batches are atomic.
    const session = active ?? {
      ownerKey: owner, turnNonce: claims.turnNonce, started: claims.turnStarted,
      compactionEpoch: claims.compactionEpoch, calls: new Set<string>(), retiredIds: new Set<string>(),
    };
    session.turnNonce = claims.turnNonce;
    session.started = claims.turnStarted;
    this.sessions.set(claims.sessionID, session);
    for (const entry of entries) {
      session.calls.add(entry.callId);
      this.calls.set(entry.callId, entry);
    }
  }

  /** Validate full native OpenCode history and commit only newly delivered results. */
  validateContinuation(claims: OpenCodeTurnClaims, input: unknown, options: { consume?: boolean } = {}): void {
    const session = this.sessions.get(claims.sessionID);
    if (session?.ownerKey !== undefined && session.ownerKey !== ownerKey(claims)) fail("session owner changed");
    if (session && claims.compactionEpoch < session.compactionEpoch) fail("earlier compaction epoch");
    if (session && (session.turnNonce !== claims.turnNonce || session.started !== claims.turnStarted)
      && claims.turnStarted <= session.started) fail("superseded turn cannot continue");
    if (session && session.turnNonce !== claims.turnNonce && [...session.calls].some(id => this.calls.get(id)?.outputHash === undefined)) {
      fail("previous turn still has outstanding tool calls");
    }
    const advancingEpoch = session !== undefined && claims.compactionEpoch > session.compactionEpoch;
    if (!Array.isArray(input)) {
      if (advancingEpoch && session.calls.size > 0) {
        fail("compaction requires canonical native tool history to retire receipts");
      }
      if ([...this.calls.values()].some(call => call.sessionID === claims.sessionID
        && call.turnNonce === claims.turnNonce && call.outputHash === undefined)) fail("outstanding tool batch is absent");
      if (session && !advancingEpoch && session.calls.size > 0) {
        fail("canonical history omitted previously issued OpenCode tools without trusted compaction");
      }
      if (advancingEpoch && options.consume !== false) session.compactionEpoch = claims.compactionEpoch;
      return;
    }

    const seen = new Map<string, { call: IssuedCall; output?: string }>();
    const fresh = new Map<string, string>();
    for (const item of input) {
      if (!record(item) || (item.type !== "function_call" && item.type !== "function_call_output")) continue;
      const callId = item.call_id;
      if (typeof callId !== "string") fail("tool call ID is missing");
      if (session?.retiredIds.has(callId)) fail("compacted tool call ID was replayed");
      const issued = this.calls.get(callId);
      if (!issued || issued.sessionID !== claims.sessionID || issued.ownerKey !== ownerKey(claims)) {
        fail("unissued or cross-session tool call");
      }
      if (item.type === "function_call") {
        if (seen.has(callId)) fail("duplicate tool call");
        if (issued.name !== item.name || issued.argsHash !== argumentsHash(item.arguments ?? "{}")) {
          fail("tool name or arguments differ from broker-issued call");
        }
        seen.set(callId, { call: issued });
      } else {
        const previous = seen.get(callId);
        if (!previous || previous.output !== undefined) fail("result lacks a unique matching issued call");
        if (typeof item.output !== "string" && !Array.isArray(item.output)) fail("tool output is invalid");
        const outputHash = digest(item.output, MAX_OUTPUT_BYTES);
        previous.output = outputHash;
        if (issued.outputHash !== undefined) {
          if (issued.outputHash !== outputHash) fail("previously completed tool output was changed");
        } else {
          if (issued.turnNonce !== claims.turnNonce || issued.model !== claims.model || issued.toolsHash !== claims.toolsHash) {
            fail("tool result belongs to a different turn or inventory");
          }
          fresh.set(callId, outputHash);
        }
      }
    }
    for (const { call, output } of seen.values()) {
      if (output === undefined) fail(`tool ${call.callId} has no result`);
    }
    const pending = [...this.calls.values()].filter(call => call.sessionID === claims.sessionID
      && call.outputHash === undefined);
    if (pending.length !== fresh.size || pending.some(call => !fresh.has(call.callId))) {
      fail("parallel tool batch has missing or unexpected results");
    }
    // The upstream Codex rollout keeps previous native tool effects in its
    // canonical history. OpenCode must likewise carry every issued receipt
    // until its signed compaction hook authorizes dropping completed calls.
    if (session && !advancingEpoch && [...session.calls].some(id => !seen.has(id))) {
      fail("canonical history omitted previously issued OpenCode tools without trusted compaction");
    }
    // A trusted compaction event permits dropping *completed* receipts absent
    // from the next canonical OpenCode history. Pending calls cannot disappear.
    const retired = advancingEpoch ? [...session.calls].filter(id => !seen.has(id)) : [];
    if (advancingEpoch && retired.some(id => this.calls.get(id)?.outputHash === undefined)) {
      fail("compaction cannot retire an outstanding tool call");
    }
    if (session && session.retiredIds.size + retired.length > MAX_RETIRED_IDS_PER_SESSION) {
      fail("compacted call ID capacity exceeded; session recovery required");
    }
    // OpenCode replays canonical completed history in later provider requests.
    // The signed request nonce rejects transport replay, while matching stored
    // output hashes lets legitimate same-turn and later-turn history pass.
    if (options.consume !== false) {
      for (const [id, hash] of fresh) this.calls.get(id)!.outputHash = hash;
      if (session && advancingEpoch) {
        for (const id of retired) {
          session.calls.delete(id);
          session.retiredIds.add(id);
          this.calls.delete(id);
        }
        session.compactionEpoch = claims.compactionEpoch;
      }
      if (session && claims.turnStarted > session.started) {
        session.turnNonce = claims.turnNonce;
        session.started = claims.turnStarted;
      }
    }
  }

  /** Only explicit trusted session destruction may discard remaining receipts. */
  retireSession(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    for (const id of session.calls) this.calls.delete(id);
    this.sessions.delete(sessionID);
  }
}
