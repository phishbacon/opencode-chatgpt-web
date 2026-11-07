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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  private loaded = false;

  /**
   * Optional on-disk state (bridge home, mode0600): receipts are otherwise
   * in-process, so a bridge restart would forget completed calls and every
   * later continuation of retained OpenCode history would fail closed as
   * "unissued". Persisting keeps the fail-closed semantics across restarts.
   * Without a path (tests, ad-hoc servers) the ledger stays in-memory.
   */
  constructor(private readonly statePath?: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.statePath) return;
    try {
      if (!existsSync(this.statePath)) return;
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        version?: number;
        calls?: unknown;
        sessions?: unknown;
      };
      if (raw.version !== 1 || !Array.isArray(raw.calls) || !Array.isArray(raw.sessions)) return;
      for (const value of raw.calls) {
        if (!record(value)) continue;
        const call = value as unknown as IssuedCall;
        if (typeof call.callId !== "string" || typeof call.sessionID !== "string"
          || typeof call.argsHash !== "string" || typeof call.turnNonce !== "string"
          || typeof call.ownerKey !== "string" || typeof call.model !== "string"
          || typeof call.toolsHash !== "string" || typeof call.name !== "string") continue;
        if (this.calls.size >= MAX_CALLS) break;
        this.calls.set(call.callId, call);
      }
      for (const entry of raw.sessions) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !record(entry[1])) continue;
        const stored = entry[1] as Record<string, unknown>;
        if (!Array.isArray(stored.calls) || !Array.isArray(stored.retiredIds)) continue;
        this.sessions.set(entry[0], {
          ownerKey: String(stored.ownerKey),
          turnNonce: String(stored.turnNonce),
          started: Number(stored.started),
          compactionEpoch: Number(stored.compactionEpoch),
          calls: new Set(stored.calls.filter((id): id is string => typeof id === "string")),
          retiredIds: new Set(stored.retiredIds.filter((id): id is string => typeof id === "string")),
        });
      }
    } catch {
      /* Corrupt or unreadable state fails closed to an empty ledger. */
    }
  }

  private save(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${process.pid}.tmp`;
      const payload = {
        version: 1,
        calls: [...this.calls.values()],
        sessions: [...this.sessions].map(([id, session]) => [id, {
          ownerKey: session.ownerKey,
          turnNonce: session.turnNonce,
          started: session.started,
          compactionEpoch: session.compactionEpoch,
          calls: [...session.calls],
          retiredIds: [...session.retiredIds],
        }]),
      };
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      try { chmodSync(temporary, statSync(this.statePath).mode & 0o777); } catch { /* keep0600 */ }
      renameSync(temporary, this.statePath);
    } catch {
      /* Persistence must never break a turn; in-memory state still applies. */
      try { rmSync(`${this.statePath}.${process.pid}.tmp`, { force: true }); } catch { /* best effort */ }
    }
  }

  issueBatch(claims: OpenCodeTurnClaims, wireTools: unknown, batch: readonly OpenCodeIssuedToolCall[]): void {
    this.load();
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
    this.save();
  }

  /** Validate full native OpenCode history and commit only newly delivered results. */
  validateContinuation(claims: OpenCodeTurnClaims, input: unknown, options: { consume?: boolean } = {}): void {
    this.load();
    const session = this.sessions.get(claims.sessionID);
    if (session?.ownerKey !== undefined && session.ownerKey !== ownerKey(claims)) fail("session owner changed");
    if (session && claims.compactionEpoch < session.compactionEpoch) fail("earlier compaction epoch");
    if (session && (session.turnNonce !== claims.turnNonce || session.started !== claims.turnStarted)
      && claims.turnStarted <= session.started) fail("superseded turn cannot continue");
    // Outstanding receipts are deliberately not a fail-fast here: if the
    // issuing turn died before its continuation arrived (timeout, crash, a
    // rejected request), a later turn's canonical history resolves the batch
    // in the fresh-commit path below. Requests that do not carry the results
    // still fail closed when the pending batch is reconciled against input.
    const advancingEpoch = session !== undefined && claims.compactionEpoch > session.compactionEpoch;
    // A compaction body renders the conversation to summarize it (full
    // transcript, kept tail dropped, or flattened to text) — it is not a
    // continuation. Receipts reconcile at the following epoch boundary against
    // the real post-compaction history instead of against this input.
    const summarizing = claims.purpose === "compaction";
    if (!Array.isArray(input)) {
      if (advancingEpoch && session.calls.size > 0) {
        fail("compaction requires canonical native tool history to retire receipts");
      }
      if (!summarizing && [...this.calls.values()].some(call => call.sessionID === claims.sessionID
        && call.turnNonce === claims.turnNonce && call.outputHash === undefined)) fail("outstanding tool batch is absent");
      if (session && !advancingEpoch && !summarizing && session.calls.size > 0) {
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
        // OpenCode history is canonical: a signed compaction summary may
        // replay tool history that predates this ledger (pre-persistence
        // history, or a bridge restart before receipts were persisted).
        // Compaction executes nothing and stays bound to session/owner/epoch
        // by HMAC; calls this process did issue keep the cross-session check,
        // and primary requests remain fail-closed for unknown history.
        if (claims.purpose === "compaction" && !issued) continue;
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
          // Fresh results normally arrive in the issuing turn. If that turn
          // died before its continuation, a later turn's canonical history may
          // resolve the outstanding batch: session, owner and exact call
          // identity (name/arguments) are proven above, so a dead batch is
          // recoverable without weakening issuance or cross-session checks.
          // Same-turn commits still require the issuing model and inventory.
          if (issued.turnNonce === claims.turnNonce
            && (issued.model !== claims.model || issued.toolsHash !== claims.toolsHash)) {
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
    // Normal turns must reconcile every outstanding result from their input.
    // A compaction body may omit them by construction, and the first request
    // after compaction reconciles them against the new canonical history.
    if (!advancingEpoch && !summarizing
      && (pending.length !== fresh.size || pending.some(call => !fresh.has(call.callId)))) {
      fail("parallel tool batch has missing or unexpected results");
    }
    // The upstream Codex rollout keeps previous native tool effects in its
    // canonical history. OpenCode must likewise carry every issued receipt
    // until its signed compaction hook authorizes dropping completed calls.
    if (session && !advancingEpoch && !summarizing && [...session.calls].some(id => !seen.has(id))) {
      fail("canonical history omitted previously issued OpenCode tools without trusted compaction");
    }
    // A trusted compaction boundary retires receipts absent from the new
    // canonical history, including results that never arrived: the compacted
    // history no longer carries their calls, and retiredIds burns the IDs so
    // they can never be replayed. Results present above are committed first.
    const retired = advancingEpoch ? [...session.calls].filter(id => !seen.has(id)) : [];
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
      this.save();
    }
  }

  /** Durable per-session compaction epochs (healthz sync source for the signer). */
  sessionEpochs(): Record<string, number> {
    this.load();
    const epochs: Record<string, number> = {};
    for (const [sessionID, session] of this.sessions) epochs[sessionID] = session.compactionEpoch;
    return epochs;
  }

  /** Only explicit trusted session destruction may discard remaining receipts. */
  retireSession(sessionID: string): void {
    this.load();
    const session = this.sessions.get(sessionID);
    if (!session) return;
    for (const id of session.calls) this.calls.delete(id);
    this.sessions.delete(sessionID);
    this.save();
  }
}
