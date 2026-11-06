/**
 * The original Codex harness serializes Codex rollout history and stages large
 * prompts with CODEX_MULTIPART_ACK. OpenCode uses the same integrity-checked
 * browser transport but keeps its own canonical role history, live identifiers,
 * plugin name and OPENCODE_MULTIPART_ACK protocol intact.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capability = "turn_" + "e".repeat(32);
const historical = {
  turn: "turn_" + "a".repeat(32),
  request: "request_" + "b".repeat(32),
  binding: "binding_" + "c".repeat(32),
};
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const escaped = 'Keep `backticks`, \\u0060, "quotes", [link](https://example.invalid) and 中文 😀';

function openCodeRequest(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: [`system: ${historical.turn} ${escaped}`],
      messages: [
        { role: "developer", content: `developer: ${historical.request}`, timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: `Earlier assistant ${historical.binding}` }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_opencode1", toolName: "shell", isError: false,
          content: `stdout ${historical.turn}\n${escaped}`, timestamp: 3 },
        { role: "user", content: "Proceed with the real task", timestamp: 4 },
      ],
    },
    _openCodeTurn: {
      v: 2, sessionID: "ses_123456789", messageID: "msg_123456789",
      turnNonce: "1".repeat(32), requestNonce: "2".repeat(32),
      turnStarted: 1_800_000_000_000, compactionEpoch: 0,
      issuedAt: 1_800_000_000_001, expiresAt: 1_800_000_120_001,
      model: "opencode-chatgpt-web/gpt-6", toolsHash: "3".repeat(64),
      owner: { cwd: join(tmpdir(), "open-code-project"), projectID: "pro_123456789", agent: "build" },
    },
  };
}

function records(compiled: ReturnType<typeof compileChatGptWebPrompt>): {
  system: string[]; messages: Record<string, unknown>[];
} {
  const parts = compiled.multipart!.parts.map(part => JSON.parse(part) as {
    version: number; total_parts: number; part_index: number;
    records: Array<{ kind: "system"; system_index: number; content: string }
      | { kind: "message"; message_index: number; message: Record<string, unknown> }>;
  });
  for (const [index, part] of parts.entries()) {
    expect(part.part_index).toBe(index + 1);
    expect(part.total_parts).toBe(parts.length);
    expect(part.version).toBe(1);
  }
  const all = parts.flatMap(part => part.records);
  const system = all.filter(record => record.kind === "system")
    .sort((a, b) => a.system_index - b.system_index).map(record => record.content);
  const messages = all.filter(record => record.kind === "message")
    .sort((a, b) => a.message_index - b.message_index).map(record => record.message);
  return { system, messages };
}

describe("OpenCode browser prompt contract", () => {
  test("inline preserves roles, hierarchy, historical handles and transport capability", () => {
    const compiled = compileChatGptWebPrompt(openCodeRequest(), capabilities, capability, {
      appName: "opencode-chatgpt-web", includeContextTokenBreakdown: true,
    });
    const text = compiled.text;
    const json = text.match(/<opencode_context_json>\n(.+)\n<\/opencode_context_json>/s)![1]!;
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(3);
    expect(parsed.system).toContain(`system: ${historical.turn} ${escaped}`);
    expect(parsed.messages.map((entry: { role: string }) => entry.role))
      .toEqual(["developer", "assistant", "tool_result", "user"]);
    expect(parsed.messages[0].content).toBe(`developer: ${historical.request}`);
    expect(parsed.messages[1].content[0].text).toBe(`Earlier assistant ${historical.binding}`);
    expect(parsed.messages[2].content).toBe(`stdout ${historical.turn}\n${escaped}`);
    expect(parsed.messages[2].tool_call_id).toBe("call_opencode1");
    expect(json).not.toContain("`");
    expect(text).toContain("Honor the original instruction priority: system, then developer, then user.");
    expect(text).toContain('The website plugin for this OpenCode turn is "opencode-chatgpt-web".');
    expect(text.match(new RegExp(capability, "g"))).toHaveLength(1);
    expect(text).toContain("<opencode_transport_resume>");
    expect(text).not.toContain("<codex_context_json>");
    expect(text).not.toContain("The selected local OpenCode plugin");
    expect(compiled.contextTokenBreakdown?.tool_result?.records).toBe(1);
  });

  test.each([2, 6] as const)("%i-part transport stages and commits in order with exact hashes", parts => {
    const parsed = openCodeRequest();
    const compiled = compileChatGptWebPrompt(parsed, capabilities, capability, {
      appName: "opencode-chatgpt-web", experimentalMultipartParts: parts,
    });
    const multipart = compiled.multipart!;
    expect(multipart.flavor).toBe("opencode");
    expect(multipart.parts).toHaveLength(parts);
    expect(records(compiled)).toEqual({
      system: parsed.context.systemPrompt!,
      messages: [
        { role: "developer", content: parsed.context.messages[0]!.content },
        { role: "assistant", content: [{ type: "text", text: `Earlier assistant ${historical.binding}` }] },
        { role: "tool_result", tool_call_id: "call_opencode1", tool_name: "shell", is_error: false,
          content: `stdout ${historical.turn}\n${escaped}` },
        { role: "user", content: "Proceed with the real task" },
      ],
    });
    const txn = `ctx_${"d".repeat(32)}`;
    for (const [index, payload] of multipart.parts.slice(0, -1).entries()) {
      const stage = formatChatGptWebMultipartStage(payload, txn, index + 1, parts, multipart.flavor);
      const sha = createHash("sha256").update(payload).digest("hex");
      expect(stage.sha256).toBe(sha);
      expect(stage.acknowledgement).toBe(`OPENCODE_MULTIPART_ACK ${txn} ${index + 1}/${parts} ${sha}`);
      expect(stage.text).toContain("<opencode_multipart_stage>");
      expect(stage.text).toContain("<opencode_context_part_json>");
      expect(stage.text).not.toContain("codex_");
      expect(stage.text).not.toContain("Codex");
      expect(stage.text).toContain(payload);
      expect(payload).not.toContain("`");
    }
    const commit = formatChatGptWebMultipartCommit(multipart, txn);
    const manifest = multipart.parts.map((part, index) =>
      `${index + 1}/${parts}:${createHash("sha256").update(part).digest("hex")}`).join(" ");
    expect(commit).toContain(`manifest: ${manifest}`);
    expect(commit).toContain(`<opencode_multipart_execute>`);
    expect(commit).toContain(`All ${parts} context parts are now present. Reconstruct the original OpenCode context`);
    expect(commit).toContain(multipart.parts.at(-1)!);
    expect(commit).toContain("<opencode_transport_resume>");
    expect(commit).toContain('The website plugin for this OpenCode turn is "opencode-chatgpt-web".');
    expect(commit.match(new RegExp(capability, "g"))).toHaveLength(1);
    expect(commit).not.toContain("<codex_multipart_commit>");
    expect(commit).not.toContain("CODEX_MULTIPART_ACK");
    expect(commit).not.toContain("The selected local OpenCode plugin");
    expect(multipart.commit.match(new RegExp(capability, "g"))).toHaveLength(1);
  });

  test("missing broker capability and compaction on authenticated OpenCode turns fail closed", () => {
    expect(() => compileChatGptWebPrompt(openCodeRequest(), capabilities)).toThrow("broker turn token");
    const parsed = openCodeRequest();
    parsed._compactionRequest = { } as CodexParsedRequest["_compactionRequest"];
    expect(() => compileChatGptWebPrompt(parsed, capabilities, capability)).toThrow("authenticated ordinary turn");
  });
});
