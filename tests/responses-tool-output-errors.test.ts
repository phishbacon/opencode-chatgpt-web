import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

function parseToolResult(output: unknown) {
  const parsed = parseRequest({
    model: "gpt-6-sol",
    input: [
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"path\":\"/etc/hostname\"}" },
      { type: "function_call_output", call_id: "call_1", output },
    ],
  });
  const results = parsed.context.messages.filter(message => message.role === "toolResult");
  expect(results).toHaveLength(1);
  return results[0]!;
}

test("an OpenCode error payload is reported as a failed tool result", () => {
  const result = parseToolResult(
    "{\"error\":{\"type\":\"permission.rejected\",\"message\":\"Permission denied: read\"},\"content\":[]}",
  );
  expect(result.isError).toBe(true);
  expect(result.content).toContain("permission.rejected");
});

test("plain tool output stays a successful result", () => {
  const result = parseToolResult("Read file README.md, lines 1-214");
  expect(result.isError).toBe(false);
  expect(result.content).toBe("Read file README.md, lines 1-214");
});

test("JSON output without an error object stays successful", () => {
  expect(parseToolResult("{\"result\":\"ok\"}").isError).toBe(false);
  expect(parseToolResult("{\"error\":null,\"content\":[\"fine\"]}").isError).toBe(false);
  expect(parseToolResult("[{\"type\":\"output_text\",\"text\":\"fine\"}]").isError).toBe(false);
});

test("a custom tool call output keeps the same error detection", () => {
  const parsed = parseRequest({
    model: "gpt-6-sol",
    input: [
      { type: "custom_tool_call", call_id: "call_2", name: "exec", input: "run" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "{\"error\":{\"type\":\"exit\"}}" },
    ],
  });
  const results = parsed.context.messages.filter(message => message.role === "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0]!.isError).toBe(true);
});
