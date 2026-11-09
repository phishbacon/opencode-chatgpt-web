/**
 * Upstream Codex receives native turn ownership from Codex-generated rollout
 * metadata. OpenCode must authenticate an equivalent owner through signed V2
 * hook claims; these tests verify the OpenCode-only trust boundary.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import {
  OpenCodeTurnIssuer,
  OpenCodeTurnVerifier,
  hashOpenCodeTrustedTools,
  parseTurnSigningKey,
} from "../src/opencode/turn-binding";

const SESSION = "ses_123456789";
const MESSAGE = "msg_123456789";
const MODEL = "opencode-chatgpt-web/gpt-6";
const TOOLS = {
  shell: { description: "Execute command", input: { type: "object", properties: { command: { type: "string" } } } },
  read: { description: "Read a file", input: { type: "object", properties: { path: { type: "string" } } } },
};
const OWNER = { cwd: join(tmpdir(), "example-workspace"), projectID: "pro_123456789", agent: "build" };

function fixture() {
  const key = randomBytes(32);
  let time = 1_800_000_000_000;
  const clock = () => time;
  const issuer = new OpenCodeTurnIssuer(key, clock);
  const verifier = new OpenCodeTurnVerifier(key, clock);
  const begin = (message = MESSAGE) => {
    issuer.beginPrompt(SESSION, message);
    issuer.observeContext(SESSION, MODEL, TOOLS, OWNER);
  };
  const sign = () => issuer.signPrimaryRequest(SESSION, MODEL);
  const verify = (header: string, expected: { model: string; sessionID?: string; turnNonce?: string; toolsHash?: string } = { model: MODEL }) => verifier.verify(header, expected);
  return { key, issuer, verifier, begin, sign, verify, advance: (ms: number) => { time += ms; } };
}

describe("OpenCode turn ownership", () => {
  test("valid primary and continuation calls keep one turn, without tool authority", () => {
    const f = fixture();
    f.begin();
    const a = f.verify(f.sign());
    const b = f.verify(f.sign(), { model: MODEL, sessionID: SESSION, turnNonce: a.turnNonce });
    expect(a.sessionID).toBe(SESSION);
    expect(a.messageID).toBe(MESSAGE);
    expect(b.turnNonce).toBe(a.turnNonce);
    expect(b.requestNonce).not.toBe(a.requestNonce);
    expect(a.toolsHash).toBe(hashOpenCodeTrustedTools(Object.fromEntries(Object.entries(TOOLS).reverse())));
    expect(a.owner).toEqual(OWNER);
    expect(a.compactionEpoch).toBe(0);
    expect(Object.keys(a).sort()).toEqual([
      "compactionEpoch", "expiresAt", "issuedAt", "messageID", "model", "owner", "requestNonce", "sessionID", "toolsHash", "turnNonce", "turnStarted", "v",
    ]);
  });

  test("trusted compaction rotates the signed epoch and rejects an older signed continuation", () => {
    const f = fixture();
    f.begin();
    const earlier = f.sign();
    expect(f.verify(earlier).compactionEpoch).toBe(0);
    f.issuer.noteCompaction(SESSION);
    expect(f.verify(f.sign()).compactionEpoch).toBe(1);
    expect(() => f.verify(f.sign(), { model: "other/model" })).toThrow("does not match");
    // A previously valid, unconsumed nonce cannot restore the old browser tab.
    const beforeSecond = f.sign();
    f.issuer.noteCompaction(SESSION);
    expect(f.verify(f.sign()).compactionEpoch).toBe(2);
    expect(() => f.verify(beforeSecond)).toThrow("earlier compaction epoch");
    f.issuer.retire(SESSION);
    expect(() => f.sign()).toThrow("No trusted OpenCode prompt");
  });

  test("rejects absent prompt, invalid identity, invalid signing keys", () => {
    const f = fixture();
    expect(() => f.sign()).toThrow("No trusted OpenCode prompt");
    f.issuer.beginPrompt(SESSION, MESSAGE);
    expect(() => f.sign()).toThrow("no matching tool context");
    expect(() => f.issuer.observeContext(SESSION, MODEL, { shell: { description: 2, input: {} } }, OWNER)).toThrow("contract is invalid");
    expect(() => f.issuer.observeContext(SESSION, MODEL, { "tool name": TOOLS.shell }, OWNER)).toThrow("invalid or duplicate names");
    expect(() => f.issuer.observeContext(SESSION, "other/model", TOOLS, OWNER)).not.toThrow();
    expect(() => f.sign()).toThrow("no matching tool context");
    expect(() => f.issuer.beginPrompt("bad", MESSAGE)).toThrow("Trusted OpenCode prompt identity");
    expect(() => parseTurnSigningKey("too-short")).toThrow("32 bytes");
    expect(parseTurnSigningKey(f.key.toString("hex"))).toEqual(f.key);
  });

  test("rejects malformed header, forged signature and wrong signing key", () => {
    const f = fixture();
    f.begin();
    const signed = f.sign();
    const [payload, signature] = signed.split(".");
    const corrupt = Buffer.from(signature!, "base64url");
    corrupt[0] ^= 1;
    expect(() => f.verify(`${payload}.${corrupt.toString("base64url")}`)).toThrow("signature is invalid");
    expect(() => f.verify("garbage")).toThrow("encoding is invalid");
    const differentVerifier = new OpenCodeTurnVerifier(randomBytes(32));
    expect(() => differentVerifier.verify(signed, { model: MODEL })).toThrow("signature is invalid");
  });

  test("rejects model, session and nonce mismatch without consuming request", () => {
    const f = fixture();
    f.begin();
    const signed = f.sign();
    expect(() => f.verify(signed, { model: "other/model" })).toThrow("does not match");
    expect(() => f.verify(signed, { model: MODEL, sessionID: "ses_other123" })).toThrow("does not match");
    expect(() => f.verify(signed, { model: MODEL, turnNonce: "f".repeat(32) })).toThrow("does not match");
    expect(() => f.verify(signed, { model: MODEL, toolsHash: hashOpenCodeTrustedTools({ shell: TOOLS.shell }) })).toThrow("does not match");
    expect(f.verify(signed).sessionID).toBe(SESSION);
  });

  test("fresh context updates inventory; a new prompt cannot reuse an earlier context", () => {
    const f = fixture();
    f.begin();
    const old = f.sign();
    f.issuer.observeContext(SESSION, MODEL, { shell: TOOLS.shell }, OWNER);
    const current = f.sign();
    expect(f.verify(old, { model: MODEL, toolsHash: hashOpenCodeTrustedTools(TOOLS) }).toolsHash)
      .toBe(hashOpenCodeTrustedTools(TOOLS));
    expect(f.verify(current, { model: MODEL, toolsHash: hashOpenCodeTrustedTools({ shell: TOOLS.shell }) }).toolsHash)
      .toBe(hashOpenCodeTrustedTools({ shell: TOOLS.shell }));
    f.issuer.beginPrompt(SESSION, "msg_987654321");
    expect(() => f.sign()).toThrow("no matching tool context");
  });

  test("rejects a replayed request while allowing a new signed continuation", () => {
    const f = fixture();
    f.begin();
    const signed = f.sign();
    f.verify(signed);
    expect(() => f.verify(signed)).toThrow("already accepted");
    expect(f.verify(f.sign()).messageID).toBe(MESSAGE);
  });

  test("replays an identical signed compaction inside the retry window only", () => {
    const f = fixture();
    f.begin();
    const compaction = f.issuer.signCompactionRequest(SESSION, MODEL);
    expect(f.verify(compaction).purpose).toBe("compaction");
    // OpenCode's shrink-retry re-sends the one prepared header; the read-only
    // compaction is re-served while claims are live and the window holds.
    expect(f.verify(compaction).purpose).toBe("compaction");
    f.advance(50_000);
    expect(f.verify(compaction).purpose).toBe("compaction");
    // Past the window (but before claim expiry) the replay is rejected again,
    // and repeated re-sends cannot extend their own window.
    f.advance(30_000);
    expect(() => f.verify(compaction)).toThrow("already accepted");
    // Primaries are one-shot regardless of the compaction window.
    const primary = f.sign();
    f.verify(primary);
    expect(() => f.verify(primary)).toThrow("already accepted");
  });

  test("rejects expired and future-dated calls", () => {
    const f = fixture();
    f.begin();
    const signed = f.sign();
    f.advance(600_000);
    expect(() => f.verify(signed)).toThrow("expired or is from the future");
    const future = fixture();
    future.begin();
    const futureSigned = future.sign();
    future.advance(-5_001);
    expect(() => future.verify(futureSigned)).toThrow("expired or is from the future");
  });

  test("a newer prompt supersedes the prior turn, even within the same millisecond", () => {
    const f = fixture();
    f.begin();
    const older = f.sign();
    f.verify(older);
    f.begin("msg_987654321");
    expect(f.verify(f.sign()).messageID).toBe("msg_987654321");
    expect(() => f.verify(f.sign(), { model: MODEL, sessionID: "ses_other123" })).toThrow("does not match");
    const oldContinuation = new OpenCodeTurnIssuer(f.key, () => 1_800_000_000_000);
    oldContinuation.beginPrompt(SESSION, MESSAGE);
    oldContinuation.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(() => f.verify(oldContinuation.signPrimaryRequest(SESSION, MODEL))).toThrow("superseded turn");
  });

  test("retirement blocks a valid unexpired continuation; wrong retirement cannot revoke newer owner", () => {
    const f = fixture();
    f.begin();
    const initial = f.verify(f.sign());
    const pending = f.sign();
    f.verifier.retire(SESSION, "f".repeat(32));
    expect(f.verify(pending).turnNonce).toBe(initial.turnNonce);
    f.verifier.retire(SESSION, initial.turnNonce);
    expect(() => f.verify(f.sign())).toThrow("retired turn");
    f.begin("msg_987654321");
    const newer = f.verify(f.sign());
    f.verifier.retire(SESSION, initial.turnNonce);
    expect(f.verify(f.sign()).turnNonce).toBe(newer.turnNonce);
  });

  test("requires a trusted absolute session directory and locks project and agent to the active turn", () => {
    const f = fixture();
    f.issuer.beginPrompt(SESSION, MESSAGE);
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, cwd: "relative/path" }))
      .toThrow("session owner is invalid");
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, cwd: "/tmp/../other" }))
      .toThrow("session owner is invalid");
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, agent: "" }))
      .toThrow("session owner is invalid");
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, projectID: "?" }))
      .toThrow("session owner is invalid");
    f.issuer.observeContext(SESSION, MODEL, TOOLS, OWNER);
    const signed = f.sign();
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, cwd: join(tmpdir(), "other-workspace") }))
      .toThrow("session owner changed within a turn");
    expect(() => f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, agent: "plan" }))
      .toThrow("session owner changed within a turn");
    expect(f.verify(signed).owner).toEqual(OWNER);
    f.issuer.beginPrompt(SESSION, "msg_987654321");
    f.issuer.observeContext(SESSION, MODEL, TOOLS, { ...OWNER, agent: "plan" });
    expect(f.verify(f.sign()).owner.agent).toBe("plan");
  });

  test("prompt-start compaction reuses the last observed same-model context", () => {
    const f = fixture();
    f.begin();
    const prior = f.verify(f.sign());
    // OpenCode may dispatch compaction for a fresh prompt before that prompt's
    // context hook runs; the compaction claims must bind the ACTIVE prompt but
    // may fall back to the session's last trusted context of the same model.
    // beginPrompt directly: the fixture's begin() would also observe context.
    f.issuer.beginPrompt(SESSION, "msg_987654321");
    const claims = f.verify(f.issuer.signCompactionRequest(SESSION, MODEL));
    expect(claims.purpose).toBe("compaction");
    expect(claims.messageID).toBe("msg_987654321");
    expect(claims.toolsHash).toBe(prior.toolsHash);
    expect(claims.owner).toEqual(OWNER);
    expect(claims.turnNonce).not.toBe(prior.turnNonce);
    // The primary request for the same prompt stays strict until its own
    // context hook observes, and then signs normally.
    expect(() => f.sign()).toThrow("no matching tool context");
    f.issuer.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(() => f.sign()).not.toThrow();
  });

  test("prompt-start compaction refuses another model and an unseen session context", () => {
    const f = fixture();
    f.begin();
    f.issuer.beginPrompt(SESSION, "msg_987654321");
    expect(() => f.issuer.signCompactionRequest(SESSION, "opencode-chatgpt-web/other-model"))
      .toThrow("no matching tool context");
    const bare = new OpenCodeTurnIssuer(randomBytes(32), () => 1_800_000_000_000);
    bare.beginPrompt("ses_abcdefgh", "msg_abcdefgh");
    expect(() => bare.signCompactionRequest("ses_abcdefgh", MODEL))
      .toThrow("no matching tool context");
  });

  test("compaction epochs survive plugin reloads via disk persistence and bridge merge", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "oc-epochs-")), "compaction-epochs.json");
    const key = randomBytes(32);
    let now = 1_800_000_000_000;
    const clock = () => now;
    const verifier = new OpenCodeTurnVerifier(key, clock);

    const issuerA = new OpenCodeTurnIssuer(key, clock, statePath);
    issuerA.beginPrompt(SESSION, MESSAGE);
    issuerA.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(verifier.verify(issuerA.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false }).compactionEpoch).toBe(0);
    issuerA.noteCompaction(SESSION);
    expect(readFileSync(statePath, "utf8")).toContain(SESSION);

    // Plugin reload: a fresh issuer must recover epoch1 from disk.
    now += 60_000;
    const issuerB = new OpenCodeTurnIssuer(key, clock, statePath);
    issuerB.beginPrompt(SESSION, "msg_987654321");
    issuerB.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(verifier.verify(issuerB.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false }).compactionEpoch).toBe(1);

    // A reload with no local state adopts the bridge's higher epochs instead of
    // demoting the session (the "earlier compaction epoch" failure).
    const issuerC = new OpenCodeTurnIssuer(key, clock);
    issuerC.mergeEpochs({ [SESSION]: 7, "ses_malicious999": -1, "not-a-session": 1.5 });
    issuerC.beginPrompt(SESSION, "msg_999999999");
    issuerC.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(verifier.verify(issuerC.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false }).compactionEpoch).toBe(7);

    // Corrupt state fails safe to zero epochs (pre-persistence behavior).
    writeFileSync(statePath, "{corrupt");
    const issuerD = new OpenCodeTurnIssuer(key, clock, statePath);
    issuerD.beginPrompt(SESSION, "msg_888888888");
    issuerD.observeContext(SESSION, MODEL, TOOLS, OWNER);
    expect(verifier.verify(issuerD.signPrimaryRequest(SESSION, MODEL), { model: MODEL }, { consume: false }).compactionEpoch).toBe(0);
  });

  test("rejects same-nonce signed changes in session owner even when a second issuer holds the signing key", () => {
    const f = fixture();
    f.begin();
    const first = f.verify(f.sign());
    // Cannot spoof the random turnNonce through the supported issuer API, so tamper
    // with the authenticated payload and re-sign using the fixture test key.
    const from = f.sign().split(".")[0]!;
    const claims = JSON.parse(Buffer.from(from, "base64url").toString("utf8"));
    claims.owner.cwd = join(tmpdir(), "other-workspace");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const mac = createHmac("sha256", f.key).update(payload).digest("base64url");
    expect(() => f.verify(`${payload}.${mac}`)).toThrow("changed trusted session owner");
    expect(f.verify(f.sign()).owner).toEqual(OWNER);
  });

  test("a compaction summary request carries its own turn identity and purpose", () => {
    const f = fixture();
    f.begin();
    const primary = f.verify(f.sign());
    const compaction = f.verify(f.issuer.signCompactionRequest(SESSION, MODEL));

    expect(compaction.purpose).toBe("compaction");
    expect(compaction.sessionID).toBe(primary.sessionID);
    expect(compaction.messageID).toBe(primary.messageID);
    // The verifier accepts one active turn per prompt, so the summary keeps the
    // originating turn identity and only marks itself for the bridge.
    expect(compaction.turnNonce).toBe(primary.turnNonce);
    expect(compaction.turnStarted).toBe(primary.turnStarted);
    expect(compaction.requestNonce).not.toBe(primary.requestNonce);
    expect(compaction.compactionEpoch).toBe(primary.compactionEpoch);
    expect(compaction.toolsHash).toBe(primary.toolsHash);
    expect(compaction.owner).toEqual(primary.owner);
    expect(Object.hasOwn(primary, "purpose")).toBe(false);

    // A signed purpose value other than compaction is rejected.
    const from = f.issuer.signCompactionRequest(SESSION, MODEL).split(".")[0]!;
    const claims = JSON.parse(Buffer.from(from, "base64url").toString("utf8")) as Record<string, unknown>;
    claims.purpose = "bogus";
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const mac = createHmac("sha256", f.key).update(payload).digest("base64url");
    expect(() => f.verify(`${payload}.${mac}`)).toThrow("fields are invalid");
  });
});
