/**
 * Original Codex harness owns session deletion in its native rollout and can
 * retire the matching retained ChatGPT tab directly. OpenCode emits a trusted
 * V2 session.deleted event on the host, so its integration plugin signs a
 * short-lived, owner-bound deletion notice. The Responses bridge verifies that
 * notice before revoking the same browser and tool receipts Codex would close.
 * This notice carries no filesystem authority or independent tool access.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  OpenCodeTurnBindingError, type OpenCodeTurnOwner, OpenCodeTurnVerifier,
  validOpenCodeOwner,
} from "./turn-binding";

export const OPENCODE_SESSION_DELETED_HEADER = "x-opencode-session-deleted";
export const OPENCODE_SESSION_DELETED_PATH = "/internal/opencode/session-deleted";
const SESSION_ID = /^[A-Za-z0-9_-]{8,160}$/;
const TTL_MS = 60_000;
const SKEW_MS = 5_000;
const DOMAIN = "opencode-session-deletion-v1\0";

interface DeletionNotice {
  v: 1;
  sessionID: string;
  owner: OpenCodeTurnOwner;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function sign(encoded: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(DOMAIN).update(encoded).digest();
}

export function signOpenCodeSessionDeletion(
  key: Buffer, sessionID: string, owner: OpenCodeTurnOwner, now = Date.now(),
): string {
  if (!SESSION_ID.test(sessionID) || !validOpenCodeOwner(owner) || !Number.isSafeInteger(now)) {
    throw new OpenCodeTurnBindingError("Trusted OpenCode session deletion identity is invalid");
  }
  const notice: DeletionNotice = {
    v: 1, sessionID, owner: { ...owner }, issuedAt: now,
    expiresAt: now + TTL_MS, nonce: randomBytes(16).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(notice)).toString("base64url");
  return `${encoded}.${sign(encoded, key).toString("base64url")}`;
}

/** Synchronously registers a permanent tombstone before browser cleanup begins. */
export function consumeOpenCodeSessionDeletion(
  header: string, key: Buffer, turnVerifier: OpenCodeTurnVerifier, now = Date.now(),
): { sessionID: string; owner: OpenCodeTurnOwner; firstReceipt: boolean } {
  if (header.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header)) {
    throw new OpenCodeTurnBindingError("OpenCode session deletion encoding is invalid");
  }
  const [encoded, signature] = header.split(".");
  const actual = Buffer.from(signature!, "base64url");
  const expected = sign(encoded!, key);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OpenCodeTurnBindingError("OpenCode session deletion signature is invalid");
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded!, "base64url").toString("utf8")); }
  catch { throw new OpenCodeTurnBindingError("OpenCode session deletion payload is not JSON"); }
  const notice = value as Partial<DeletionNotice> | null;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)
    || Object.keys(notice).sort().join("|") !== "expiresAt|issuedAt|nonce|owner|sessionID|v"
    || notice.v !== 1 || typeof notice.sessionID !== "string" || !SESSION_ID.test(notice.sessionID)
    || !validOpenCodeOwner(notice.owner)
    || typeof notice.nonce !== "string" || !/^[a-f0-9]{32}$/.test(notice.nonce)
    || !Number.isSafeInteger(notice.issuedAt) || !Number.isSafeInteger(notice.expiresAt)
    || notice.expiresAt !== notice.issuedAt! + TTL_MS
    || !Number.isSafeInteger(now) || notice.issuedAt! > now + SKEW_MS || notice.expiresAt! <= now) {
    throw new OpenCodeTurnBindingError("OpenCode session deletion notice is invalid or expired");
  }
  const firstReceipt = turnVerifier.retireSession(notice.sessionID, notice.owner, notice.nonce);
  return { sessionID: notice.sessionID, owner: notice.owner, firstReceipt };
}

/** OpenCode must send deletion notices directly to the host bridge, never through a web page. */
export function localOpenCodeBridgeURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new OpenCodeTurnBindingError("OpenCode bridge URL is invalid"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new OpenCodeTurnBindingError("OpenCode lifecycle bridge must use a loopback HTTP base URL");
  }
  return url;
}

/** A retry uses the same notice; the bridge resumes the original cleanup result. */
export async function sendOpenCodeSessionDeletion(
  bridgeURL: string, header: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const endpoint = new URL(OPENCODE_SESSION_DELETED_PATH, localOpenCodeBridgeURL(bridgeURL));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST", headers: { [OPENCODE_SESSION_DELETED_HEADER]: header },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return;
      if (response.status < 500) {
        throw new OpenCodeTurnBindingError(`OpenCode session deletion rejected by bridge (HTTP ${response.status})`);
      }
      if (attempt === 2) throw new Error(`OpenCode session deletion bridge unavailable (HTTP ${response.status})`);
    } catch (error) {
      if (error instanceof OpenCodeTurnBindingError || attempt === 2) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
}
