/**
 * The original Codex harness permits rich Responses payloads because its native
 * rollout and environment resolver provide separate authority for continuations,
 * subagents and tools. OpenCode supplies signed turn identity through V2 hooks
 * instead. Until its own browser broker validates that authority, only the
 * observed OpenCode provider protocol may enter the shared Codex parser.
 * This validates protocol shape, not the truth of user-authored prompt text;
 * native tool permissions remain OpenCode's responsibility.
 */
import { OpenCodeTurnBindingError } from "./turn-binding";
import { REASONING_EFFORTS } from "../responses/parser";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(message: string): never {
  throw new OpenCodeTurnBindingError(`OpenCode Responses protocol: ${message}`);
}

function keysOnly(object: RecordValue, permitted: readonly string[], label: string): void {
  const unexpected = Object.keys(object).find(key => !permitted.includes(key));
  if (unexpected) reject(`${label} contains unsupported field ${unexpected}`);
}

function text(value: unknown, label: string, max = 1024): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max) reject(`${label} must be nonempty text`);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") reject(`${label} must be text`);
}

function validateContent(value: unknown, role: string): void {
  if (value === undefined || typeof value === "string") return;
  if (!Array.isArray(value)) reject(`${role} message content is invalid`);
  for (const block of value) {
    if (!isRecord(block)) reject(`${role} content block is invalid`);
    switch (block.type) {
      case "input_text":
      case "output_text":
      case "text":
        keysOnly(block, ["type", "text", "annotations"], "text block");
        if (typeof block.text !== "string") reject("text block requires text");
        break;
      case "refusal":
        keysOnly(block, ["type", "refusal"], "refusal block");
        if (typeof block.refusal !== "string") reject("refusal block requires text");
        break;
      case "input_image":
        keysOnly(block, ["type", "image_url", "file_id", "detail"], "image block");
        if (typeof block.image_url !== "string" && typeof block.file_id !== "string") reject("image block requires a source");
        break;
      case "input_file":
        keysOnly(block, ["type", "file_id", "filename", "file_data"], "file block");
        if (![block.file_id, block.file_data].some(x => typeof x === "string")) reject("file block requires a source");
        break;
      default: reject(`unsupported ${role} content block`);
    }
  }
}

function validateInput(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) reject("input must be text or an array");
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) reject("input item must be an object");
    if (item.type === "message" || (item.type === undefined && typeof item.role === "string")) {
      if (!["system", "developer", "user", "assistant"].includes(String(item.role))) reject("unsupported message role");
      keysOnly(item, ["type", "role", "content", "id", "status", "phase"], "message");
      validateContent(item.content, String(item.role));
    } else if (item.type === "function_call") {
      keysOnly(item, ["type", "id", "call_id", "name", "arguments", "status"], "function call");
      text(item.call_id, "function call ID", 256);
      text(item.name, "function name", 160);
      optionalString(item.arguments, "function arguments");
      if (calls.has(String(item.call_id))) reject("duplicate function call ID");
      calls.add(String(item.call_id));
    } else if (item.type === "function_call_output") {
      keysOnly(item, ["type", "call_id", "output"], "function result");
      text(item.call_id, "function result call ID", 256);
      if (!calls.has(String(item.call_id)) || results.has(String(item.call_id))) {
        reject("function result has no unique preceding call");
      }
      if (typeof item.output !== "string") validateContent(item.output, "tool result");
      results.add(String(item.call_id));
    } else if (item.type === "reasoning") {
      keysOnly(item, ["type", "id", "summary", "content", "encrypted_content", "status"], "reasoning");
      optionalString(item.encrypted_content, "encrypted reasoning");
      for (const field of ["summary", "content"] as const) {
        if (item[field] === undefined) continue;
        const entries = item[field];
        if (!Array.isArray(entries)) reject("reasoning blocks must be arrays");
        for (const entry of entries) {
          if (!isRecord(entry) || entry.type !== (field === "summary" ? "summary_text" : "reasoning_text")
            || typeof entry.text !== "string") reject("reasoning block is invalid");
          keysOnly(entry, ["type", "text"], "reasoning block");
        }
      }
    } else if (item.type === "configuration_update") {
      // OpenCode replaces its reasoning-effort config message with this
      // bookkeeping item mid-history. The effort also travels in the top-level
      // reasoning field, so the shared parser may drop the item unchanged.
      keysOnly(item, ["type", "reasoning"], "configuration update");
      const reasoning = item.reasoning;
      if (reasoning !== undefined) {
        if (!isRecord(reasoning)) reject("configuration update reasoning must be an object");
        keysOnly(reasoning, ["effort"], "configuration update reasoning");
        if (reasoning.effort !== undefined
          && (typeof reasoning.effort !== "string"
            || (reasoning.effort !== "ultra" && !REASONING_EFFORTS.has(reasoning.effort)))) {
          reject("configuration update effort is invalid");
        }
      }
    } else {
      // Includes Codex agent_message, additional_tools and unknown loose-schema
      // items. Those have no authenticated OpenCode counterpart yet.
      const described = item.type === undefined ? "(none)" : String(item.type).slice(0, 64);
      const keys = Object.keys(item).slice(0, 16).join(",");
      reject(`unsupported input item type ${JSON.stringify(described)} keys=[${keys}]`);
    }
  }
}

function validateToolChoice(value: unknown, toolNames: Set<string>): void {
  if (value === undefined || ["auto", "none", "required"].includes(value as string)) return;
  if (!isRecord(value)) reject("unsupported tool choice");
  if (value.type === "function") {
    keysOnly(value, ["type", "name"], "tool choice");
    if (!toolNames.has(String(value.name))) reject("tool choice is outside the signed inventory");
    return;
  }
  if (value.type === "allowed_tools") {
    keysOnly(value, ["type", "mode", "tools"], "tool choice");
    if (!["auto", "required"].includes(String(value.mode)) || !Array.isArray(value.tools)) reject("invalid allowed tools choice");
    for (const tool of value.tools) {
      if (!isRecord(tool)) reject("allowed tool must be an object");
      keysOnly(tool, ["type", "name"], "allowed tool");
      if (tool.type !== "function" || !toolNames.has(String(tool.name))) reject("allowed tool is outside the signed inventory");
    }
    return;
  }
  reject("unsupported hosted or custom tool choice");
}

/** Reject Codex-specific continuation or authority controls before parsing. */
export function validateOpenCodeResponsesProtocol(body: unknown): void {
  if (!isRecord(body)) reject("body must be an object");
  keysOnly(body, [
    "model", "input", "instructions", "tools", "tool_choice", "max_output_tokens",
    "temperature", "top_p", "stream", "reasoning", "store",
    "parallel_tool_calls", "prompt_cache_key", "include", "text",
  ], "request");
  if (body.client_metadata !== undefined || body.metadata !== undefined || body.previous_response_id !== undefined) {
    reject("native OpenCode continuation metadata is unsupported");
  }
  validateInput(body.input);
  const names = new Set(Array.isArray(body.tools) ? body.tools
    .filter(isRecord).map(tool => String(tool.name)) : []);
  validateToolChoice(body.tool_choice, names);
  optionalString(body.instructions, "instructions");
  optionalString(body.prompt_cache_key, "prompt cache key");
  if (body.stream !== undefined && typeof body.stream !== "boolean") reject("stream must be boolean");
  if (body.store !== undefined && typeof body.store !== "boolean") reject("store must be boolean");
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") reject("parallel_tool_calls must be boolean");
  if (body.max_output_tokens !== undefined && (!Number.isInteger(body.max_output_tokens) || (body.max_output_tokens as number) < 1)) {
    reject("max_output_tokens must be positive");
  }
  for (const field of ["temperature", "top_p"] as const) {
    if (body[field] !== undefined && (typeof body[field] !== "number" || !Number.isFinite(body[field]))) reject(`${field} must be numeric`);
  }
  if (body.reasoning !== undefined && body.reasoning !== null) {
    if (!isRecord(body.reasoning)) reject("reasoning configuration must be an object");
    keysOnly(body.reasoning, ["effort", "summary"], "reasoning configuration");
  }
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.some(x => x !== "reasoning.encrypted_content"))) {
    reject("unsupported include field");
  }
  if (body.text !== undefined) {
    if (!isRecord(body.text)) reject("text controls must be an object");
    keysOnly(body.text, ["verbosity", "format"], "text controls");
  }
}
