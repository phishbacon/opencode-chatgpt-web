/**
 * Upstream Codex sends native turn metadata in Responses client_metadata, which
 * the Codex bridge resolves against its own rollout authority. OpenCode has no
 * Codex rollout; its V2 hooks sign the originating turn in an HTTP header.
 * This guard authenticates that header before any Codex-specific routing can
 * interpret caller-controlled metadata as native turn or sandbox authority.
 */
import {
  OPENCODE_TURN_HEADER,
  OpenCodeTurnBindingError,
  hashOpenCodeWireTools,
  type OpenCodeTurnClaims,
  type OpenCodeTurnVerifier,
} from "./turn-binding";
import { validateOpenCodeResponsesProtocol } from "./response-policy";
import { OpenCodeToolReceiptLedger } from "./tool-receipts";

export const OPENCODE_MODEL_PREFIX = "opencode-chatgpt-web/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A verified identity does not authorize tools, workspace access or a browser tab. */
export function verifyOpenCodeResponsesIngress(
  request: Request,
  rawBody: unknown,
  verifier?: OpenCodeTurnVerifier,
  options: { consume?: boolean; receipts?: OpenCodeToolReceiptLedger } = {},
): OpenCodeTurnClaims | undefined {
  const model = isRecord(rawBody) ? rawBody.model : undefined;
  const isOpenCode = typeof model === "string" && model.startsWith(OPENCODE_MODEL_PREFIX);
  const header = request.headers.get(OPENCODE_TURN_HEADER);
  if (!isOpenCode && header === null) return undefined;

  if (!isOpenCode || typeof model !== "string" || model.length <= OPENCODE_MODEL_PREFIX.length) {
    throw new OpenCodeTurnBindingError("OpenCode turn header requires an OpenCode provider model");
  }
  if (!header || !verifier) {
    throw new OpenCodeTurnBindingError("OpenCode provider requests require a configured signed turn binding");
  }
  // Codex-specific metadata is not trusted in an OpenCode request, including
  // fields that could otherwise claim a different thread or sandbox authority.
  if (request.headers.has("x-codex-turn-metadata")) {
    throw new OpenCodeTurnBindingError("OpenCode requests cannot claim native OpenCode turn metadata");
  }
  const metadata = isRecord(rawBody) ? rawBody.client_metadata : undefined;
  // OpenCode provider metadata must be an object. Refuse serialized metadata
  // rather than risk a Codex authority field hidden inside a string.
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new OpenCodeTurnBindingError("OpenCode client metadata must be an object");
  }
  if (isRecord(metadata) && Object.hasOwn(metadata, "x-codex-turn-metadata")) {
    throw new OpenCodeTurnBindingError("OpenCode requests cannot claim native OpenCode turn metadata");
  }
  const input = isRecord(rawBody) ? rawBody.input : undefined;
  if (Array.isArray(input) && input.some(item => isRecord(item)
    && (Object.hasOwn(item, "internal_chat_message_metadata_passthrough")
      || item.type === "additional_tools"))) {
    throw new OpenCodeTurnBindingError("OpenCode requests cannot claim native OpenCode message provenance or inject tools");
  }
  // The upstream Codex parser accepts additional authority-bearing envelope
  // shapes. The OpenCode provider has no signed counterpart for those fields.
  validateOpenCodeResponsesProtocol(rawBody);
  const toolsHash = hashOpenCodeWireTools(isRecord(rawBody) ? rawBody.tools : undefined);
  const expected = { model, toolsHash };
  const claims = verifier.verify(header, expected, { consume: false });
  const hasToolHistory = Array.isArray(input) && input.some(item => isRecord(item)
    && (item.type === "function_call" || item.type === "function_call_output"));
  if (hasToolHistory && !options.receipts) {
    throw new OpenCodeTurnBindingError("OpenCode tool history requires bridge-issued tool receipts");
  }
  options.receipts?.validateContinuation(claims, input, { consume: false });
  if (options.consume !== false) {
    // No async gap between the preflight and the two commits. Invalid history
    // must never consume a valid signed request nonce or partial tool batch.
    verifier.verify(header, expected);
    options.receipts?.validateContinuation(claims, input);
  }
  return claims;
}
