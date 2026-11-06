/**
 * Upstream Codex identifies native turns through Codex-generated turn metadata
 * carried into the Responses bridge. OpenCode has no equivalent Codex rollout
 * metadata, so its trusted V2 hooks issue signed, short-lived turn claims here.
 *
 * OpenCode owns the source of truth for session and turn identity. Its V2 prompt
 * hook supplies the initiating messageID; its model.request hook supplies the
 * sessionID, model and request kind. This module binds those trusted events to
 * short-lived, signed provider requests. No filesystem or tool permissions may
 * be transferred in this envelope.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const HEADER_VERSION = 2;
const MAX_ENVELOPE_LENGTH = 2048;
const MAX_REQUEST_AGE_MS = 2 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const ID = /^[A-Za-z0-9_-]{8,160}$/;
const NONCE = /^[a-f0-9]{32}$/;
const TOOLS_HASH = /^[a-f0-9]{64}$/;
const TOOL_NAME = /^[\w.-]{1,160}$/;
const MAX_TOOL_COUNT = 512;
const MAX_TOOL_CONTEXT_BYTES = 4 * 1024 * 1024;

/** Trusted runtime identity only; OpenCode itself still evaluates every tool permission. */
export interface OpenCodeTurnOwner {
  cwd: string;
  projectID: string;
  agent: string;
}

export const OPENCODE_TURN_HEADER = "x-opencode-turn-binding";

export interface OpenCodeTurnClaims {
  v: 2;
  sessionID: string;
  messageID: string;
  turnNonce: string;
  requestNonce: string;
  turnStarted: number;
  /** Advanced only by OpenCode's trusted session-compaction completion event. */
  compactionEpoch: number;
  /**
   * Present only on the provider request that asks for a compaction summary.
   * It keeps the originating turn identity (the verifier accepts one active
   * turn per prompt) and tells the bridge to retire the pre-compaction browser
   * instead of queueing this request behind it.
   */
  purpose?: "compaction";
  issuedAt: number;
  expiresAt: number;
  model: string;
  toolsHash: string;
  owner: OpenCodeTurnOwner;
}

export class OpenCodeTurnBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeTurnBindingError";
  }
}

export function parseTurnSigningKey(value: string | undefined): Buffer {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new OpenCodeTurnBindingError("OpenCode turn signing key must be 32 bytes of hexadecimal data");
  }
  return Buffer.from(value, "hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Canonicalize JSON Schema recursively: object property insertion order is not authority. */
function canonicalJson(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new OpenCodeTurnBindingError("OpenCode tool schema is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonicalJson(item, depth + 1));
  if (isRecord(value)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonicalJson(value[key], depth + 1);
    return result;
  }
  throw new OpenCodeTurnBindingError("OpenCode tool schema is not JSON");
}

interface ToolContract { name: string; description: string; parameters: unknown }

function hashContracts(contracts: ToolContract[]): string {
  if (contracts.length > MAX_TOOL_COUNT || contracts.some(tool => !TOOL_NAME.test(tool.name))
    || new Set(contracts.map(tool => tool.name)).size !== contracts.length) {
    throw new OpenCodeTurnBindingError("OpenCode tool inventory contains invalid or duplicate names");
  }
  const canonical = JSON.stringify(contracts.sort((a, b) => a.name.localeCompare(b.name))
    .map(tool => [tool.name, tool.description, canonicalJson(tool.parameters)]));
  if (Buffer.byteLength(canonical) > MAX_TOOL_CONTEXT_BYTES) {
    throw new OpenCodeTurnBindingError("OpenCode tool inventory is too large");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/** Trusted V2 context uses { toolName: { description, input: JSONSchema } }. */
export function hashOpenCodeTrustedTools(tools: Record<string, unknown>): string {
  if (!isRecord(tools)) throw new OpenCodeTurnBindingError("Trusted OpenCode tools must be a record");
  return hashContracts(Object.entries(tools).map(([name, value]) => {
    if (!isRecord(value) || typeof value.description !== "string" || !isRecord(value.input)) {
      throw new OpenCodeTurnBindingError("Trusted OpenCode tool contract is invalid");
    }
    return { name, description: value.description, parameters: value.input };
  }));
}

/** Wire Responses tools must exactly match V2 descriptions and complete input schemas. */
export function hashOpenCodeWireTools(tools: unknown): string {
  if (!Array.isArray(tools)) throw new OpenCodeTurnBindingError("OpenCode provider request must include the native tool inventory");
  return hashContracts(tools.map(value => {
    if (!isRecord(value) || value.type !== "function" || typeof value.name !== "string"
      || typeof value.description !== "string" || !isRecord(value.parameters)
      || (value.strict !== undefined && value.strict !== false)
      || Object.keys(value).some(key => !["type", "name", "description", "parameters", "strict"].includes(key))) {
      throw new OpenCodeTurnBindingError("OpenCode provider request has an invalid native tool contract");
    }
    return { name: value.name, description: value.description, parameters: value.parameters };
  }));
}

export function validOpenCodeOwner(value: unknown): value is OpenCodeTurnOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<OpenCodeTurnOwner>;
  return Object.keys(owner).sort().join("|") === "agent|cwd|projectID"
    && typeof owner.cwd === "string" && owner.cwd.length <= 1024
    && isAbsolute(owner.cwd) && resolve(owner.cwd) === owner.cwd
    && typeof owner.projectID === "string" && ID.test(owner.projectID)
    && typeof owner.agent === "string" && /^[\w.-]{1,160}$/.test(owner.agent);
}

export function openCodeOwnerKey(owner: OpenCodeTurnOwner): string {
  return JSON.stringify([owner.cwd, owner.projectID, owner.agent]);
}

function enforceClaims(value: unknown): asserts value is OpenCodeTurnClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenCodeTurnBindingError("OpenCode turn binding payload is invalid");
  }
  const claims = value as Partial<OpenCodeTurnClaims>;
  const expected = ["v", "sessionID", "messageID", "turnNonce", "requestNonce", "turnStarted", "compactionEpoch", "issuedAt", "expiresAt", "model", "toolsHash", "owner"];
  const keys = Object.keys(claims).sort();
  const expectedKeys = expected.sort();
  const compactionKeys = [...expectedKeys, "purpose"].sort();
  if ((keys.join("|") !== expectedKeys.join("|") && keys.join("|") !== compactionKeys.join("|"))
    || (claims.purpose !== undefined && claims.purpose !== "compaction")
    || claims.v !== HEADER_VERSION
    || typeof claims.sessionID !== "string" || !ID.test(claims.sessionID)
    || typeof claims.messageID !== "string" || !ID.test(claims.messageID)
    || typeof claims.turnNonce !== "string" || !NONCE.test(claims.turnNonce)
    || typeof claims.requestNonce !== "string" || !NONCE.test(claims.requestNonce)
    || typeof claims.model !== "string" || !/^[\w./:-]{2,160}$/.test(claims.model)
    || typeof claims.toolsHash !== "string" || !TOOLS_HASH.test(claims.toolsHash)
    || !validOpenCodeOwner(claims.owner)
    || !Number.isSafeInteger(claims.turnStarted) || !Number.isSafeInteger(claims.issuedAt)
    || !Number.isSafeInteger(claims.compactionEpoch) || claims.compactionEpoch! < 0
    || !Number.isSafeInteger(claims.expiresAt)
    || claims.turnStarted! > claims.issuedAt!
    || claims.expiresAt! !== claims.issuedAt! + MAX_REQUEST_AGE_MS) {
    throw new OpenCodeTurnBindingError("OpenCode turn binding fields are invalid");
  }
}

function signature(payload: string, signingKey: Buffer): Buffer {
  return createHmac("sha256", signingKey).update(payload).digest();
}

function signClaims(claims: OpenCodeTurnClaims, signingKey: Buffer): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload, signingKey).toString("base64url")}`;
}

function unpack(header: string, signingKey: Buffer): OpenCodeTurnClaims {
  if (header.length > MAX_ENVELOPE_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) {
    throw new OpenCodeTurnBindingError("OpenCode turn binding encoding is invalid");
  }
  const [payload, mac] = header.split(".");
  const actual = Buffer.from(mac!, "base64url");
  const expected = signature(payload!, signingKey);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OpenCodeTurnBindingError("OpenCode turn binding signature is invalid");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  } catch {
    throw new OpenCodeTurnBindingError("OpenCode turn binding payload is not JSON");
  }
  enforceClaims(claims);
  return claims;
}

interface CurrentTurn {
  messageID: string;
  turnNonce: string;
  started: number;
  context?: { model: string; toolsHash: string; owner: OpenCodeTurnOwner };
}

/** Source-side state: only the V2 plugin's trusted hooks may call these methods. */
export class OpenCodeTurnIssuer {
  private readonly current = new Map<string, CurrentTurn>();
  private readonly compactionEpochs = new Map<string, number>();

  constructor(private readonly signingKey: Buffer, private readonly clock: () => number = Date.now) {}

  beginPrompt(sessionID: string, messageID: string): void {
    if (!ID.test(sessionID) || !ID.test(messageID)) {
      throw new OpenCodeTurnBindingError("Trusted OpenCode prompt identity is invalid");
    }
    const previous = this.current.get(sessionID);
    // Monotonic across prompts even when two begin in the same millisecond.
    const started = Math.max(this.clock(), (previous?.started ?? 0) + 1);
    this.current.set(sessionID, { messageID, turnNonce: randomBytes(16).toString("hex"), started });
  }

  /** Only the trusted OpenCode event stream may signal completed compaction. */
  noteCompaction(sessionID: string): void {
    if (!ID.test(sessionID) || !this.current.has(sessionID)) return;
    const next = (this.compactionEpochs.get(sessionID) ?? 0) + 1;
    if (!Number.isSafeInteger(next)) throw new OpenCodeTurnBindingError("OpenCode compaction epoch overflow");
    this.compactionEpochs.set(sessionID, next);
  }

  observeContext(sessionID: string, model: string, tools: Record<string, unknown>, owner: OpenCodeTurnOwner): void {
    const current = this.current.get(sessionID);
    if (!current) throw new OpenCodeTurnBindingError("No trusted OpenCode prompt owns this tool context");
    if (!/^[\w./:-]{2,160}$/.test(model)) throw new OpenCodeTurnBindingError("Trusted OpenCode context model is invalid");
    if (!validOpenCodeOwner(owner)) throw new OpenCodeTurnBindingError("Trusted OpenCode session owner is invalid");
    if (current.context && openCodeOwnerKey(current.context.owner) !== openCodeOwnerKey(owner)) {
      throw new OpenCodeTurnBindingError("Trusted OpenCode session owner changed within a turn");
    }
    current.context = { model, toolsHash: hashOpenCodeTrustedTools(tools), owner: { ...owner } };
  }

  signPrimaryRequest(sessionID: string, model: string): string {
    const current = this.current.get(sessionID);
    if (!current) throw new OpenCodeTurnBindingError("No trusted OpenCode prompt owns this provider request");
    if (!current.context || current.context.model !== model) {
      throw new OpenCodeTurnBindingError("Trusted OpenCode provider request has no matching tool context");
    }
    const now = Math.max(current.started, this.clock());
    const claims: OpenCodeTurnClaims = {
      v: 2,
      sessionID,
      messageID: current.messageID,
      turnNonce: current.turnNonce,
      requestNonce: randomBytes(16).toString("hex"),
      turnStarted: current.started,
      compactionEpoch: this.compactionEpochs.get(sessionID) ?? 0,
      issuedAt: now,
      expiresAt: now + MAX_REQUEST_AGE_MS,
      model,
      toolsHash: current.context.toolsHash,
      owner: { ...current.context.owner },
    };
    enforceClaims(claims);
    return signClaims(claims, this.signingKey);
  }

  /**
   * OpenCode requests a compaction summary with its own provider request while
   * the originating turn still holds the browser session. The verifier accepts
   * one active turn per prompt, so this keeps the originating turn identity and
   * only marks the request; the bridge retires the pre-compaction browser before
   * running it instead of queueing behind a turn that can only finish once
   * compaction returns.
   */
  signCompactionRequest(sessionID: string, model: string): string {
    const current = this.current.get(sessionID);
    if (!current) throw new OpenCodeTurnBindingError("No trusted OpenCode prompt owns this provider request");
    if (!current.context || current.context.model !== model) {
      throw new OpenCodeTurnBindingError("Trusted OpenCode provider request has no matching tool context");
    }
    const now = Math.max(current.started, this.clock());
    const claims: OpenCodeTurnClaims = {
      v: 2,
      sessionID,
      messageID: current.messageID,
      turnNonce: current.turnNonce,
      requestNonce: randomBytes(16).toString("hex"),
      turnStarted: current.started,
      compactionEpoch: this.compactionEpochs.get(sessionID) ?? 0,
      purpose: "compaction",
      issuedAt: now,
      expiresAt: now + MAX_REQUEST_AGE_MS,
      model,
      toolsHash: current.context.toolsHash,
      owner: { ...current.context.owner },
    };
    enforceClaims(claims);
    return signClaims(claims, this.signingKey);
  }

  retire(sessionID: string): void {
    this.current.delete(sessionID);
    this.compactionEpochs.delete(sessionID);
  }
}

/** Bridge-side state: rejects forged, expired, replayed and superseded calls. */
export class OpenCodeTurnVerifier {
  private readonly seenRequests = new Map<string, number>();
  private readonly current = new Map<string, { nonce: string; started: number; epoch: number; ownerKey: string; retired: boolean }>();
  /** Keep authenticated deletion identity so a transport retry cannot retire another owner. */
  private readonly deletedSessions = new Map<string, { ownerKey: string; nonce: string }>();

  constructor(private readonly signingKey: Buffer, private readonly clock: () => number = Date.now) {}

  verify(
    header: string,
    expected: { model: string; sessionID?: string; turnNonce?: string; toolsHash?: string },
    options: { consume?: boolean } = {},
  ): OpenCodeTurnClaims {
    const claims = unpack(header, this.signingKey);
    if (this.deletedSessions.has(claims.sessionID)) {
      throw new OpenCodeTurnBindingError("OpenCode session has been deleted");
    }
    const now = this.clock();
    if (claims.issuedAt > now + MAX_CLOCK_SKEW_MS || claims.expiresAt <= now) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding has expired or is from the future");
    }
    if (claims.model !== expected.model || (expected.sessionID && claims.sessionID !== expected.sessionID)
      || (expected.turnNonce && claims.turnNonce !== expected.turnNonce)
      || (expected.toolsHash && claims.toolsHash !== expected.toolsHash)) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding does not match the request owner");
    }
    const active = this.current.get(claims.sessionID);
    if (active && claims.compactionEpoch < active.epoch) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding belongs to an earlier compaction epoch");
    }
    if (active && (active.nonce !== claims.turnNonce || active.started !== claims.turnStarted)
      && claims.turnStarted <= active.started) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding belongs to a superseded turn");
    }
    if (active?.nonce === claims.turnNonce && active.started === claims.turnStarted && active.retired) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding belongs to a retired turn");
    }
    if (active?.nonce === claims.turnNonce && active.started === claims.turnStarted
      && active.ownerKey !== openCodeOwnerKey(claims.owner)) {
      throw new OpenCodeTurnBindingError("OpenCode turn binding changed trusted session owner");
    }
    // Prune bounded-lived request nonces. No prompts or tool results enter this store.
    for (const [nonce, expiry] of this.seenRequests) if (expiry <= now) this.seenRequests.delete(nonce);
    const requestKey = `${claims.sessionID}:${claims.requestNonce}`;
    if (this.seenRequests.has(requestKey)) {
      throw new OpenCodeTurnBindingError("OpenCode provider request was already accepted");
    }
    // Readiness checks may inspect a signed request before browser routing is
    // available. Only an accepted route takes ownership and consumes its nonce.
    if (options.consume !== false) {
      this.current.set(claims.sessionID, { nonce: claims.turnNonce, started: claims.turnStarted,
        epoch: claims.compactionEpoch,
        ownerKey: openCodeOwnerKey(claims.owner), retired: false });
      this.seenRequests.set(requestKey, claims.expiresAt);
    }
    return claims;
  }

  retire(sessionID: string, nonce: string): void {
    const active = this.current.get(sessionID);
    // Retire only the matching owner, never a newer prompt.
    // Keep a tombstone until a newer turn replaces it: an unexpired signed
    // continuation must not resurrect an already retired browser turn.
    if (active?.nonce === nonce) active.retired = true;
  }

  /** Trusted deletion tombstone is permanent for this bridge process, even before first acceptance. */
  retireSession(sessionID: string, owner: OpenCodeTurnOwner, noticeNonce: string): boolean {
    const ownerKey = openCodeOwnerKey(owner);
    const deleted = this.deletedSessions.get(sessionID);
    if (deleted) {
      if (deleted.ownerKey !== ownerKey || deleted.nonce !== noticeNonce) {
        throw new OpenCodeTurnBindingError("OpenCode session has already been deleted with another notice");
      }
      return false;
    }
    const active = this.current.get(sessionID);
    if (active && active.ownerKey !== ownerKey) {
      throw new OpenCodeTurnBindingError("OpenCode deleted session owner does not match its authenticated turns");
    }
    this.deletedSessions.set(sessionID, { ownerKey, nonce: noticeNonce });
    if (active) active.retired = true;
    return true;
  }
}
