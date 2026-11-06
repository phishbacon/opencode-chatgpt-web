import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* from(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

function sse(events: AdapterEvent[], options?: Record<string, unknown>): Promise<string> {
  return new Response(
    bridgeToResponsesSSE(from(events), "chatgpt-web/test", undefined, undefined, undefined, undefined, 2_000,
      options as never),
  ).text();
}

function frames(body: string, event: string): string[] {
  return body.split("\n\n").filter(block => block.includes(`event: ${event}`))
    .map(block => block.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? "");
}

test("every adapter text delta becomes its own SSE delta in order, with no invented or repeated chunks", async () => {
  const deltas = ["First ", "second ", "third sentence."];
  const body = await sse([
    ...deltas.map(text => ({ type: "text_delta", text, phase: "final_answer" }) as AdapterEvent),
    { type: "done", endTurn: true },
  ]);

  const emitted = frames(body, "response.output_text.delta").map(raw => JSON.parse(raw).delta as string);
  expect(emitted).toEqual(deltas);
  // The bridge must not resplit or replay a delta: what the adapter streamed is what ChatGPT sees.
  expect(emitted.join("")).toBe(deltas.join(""));
  expect(emitted.join("").match(/second /g)).toHaveLength(1);
});

test("a single completed answer blob is never presented as fabricated incremental streaming", async () => {
  const whole = "The complete answer delivered in one settled delta.";
  const body = await sse([
    { type: "text_delta", text: whole, phase: "final_answer" },
    { type: "done", endTurn: true },
  ]);

  expect(frames(body, "response.output_text.delta")).toHaveLength(1);
  expect(JSON.parse(frames(body, "response.output_text.delta")[0]!).delta).toBe(whole);
});

test("tool arguments stream and the turn still ends with exactly one terminal response.completed", async () => {
  const body = await sse([
    { type: "text_delta", text: "Running a command.", phase: "commentary" },
    { type: "tool_call_start", id: "call_1", name: "shell" },
    { type: "tool_call_delta", arguments: "{\"command\":\"echo hi\"}" },
    { type: "tool_call_end" },
    { type: "done", stopReason: "tool_use", endTurn: false },
  ]);

  expect(frames(body, "response.function_call_arguments.delta")).toHaveLength(1);
  const added = frames(body, "response.output_item.added").map(raw => JSON.parse(raw).item)
    .find(parsed => parsed.type === "function_call");
  expect(added).toMatchObject({ name: "shell", status: "in_progress" });
  const done = frames(body, "response.output_item.done").map(raw => JSON.parse(raw).item)
    .find(parsed => parsed.type === "function_call");
  expect(done).toMatchObject({
    name: "shell", status: "completed", arguments: "{\"command\":\"echo hi\"}", call_id: "call_1",
  });
  expect(body).toContain("event: response.completed");
  expect(body).not.toContain("event: response.failed");
  expect(body).toEndWith("data: [DONE]\n\n");
  expect(body.indexOf("event: response.completed")).toBeGreaterThan(body.lastIndexOf("event: response.output_text.delta"));
});

test("reasoning summaries stream as reasoning deltas instead of arriving as one final blob", async () => {
  const summaries = ["Checking the request.", " Confirming the tool."];
  const body = await sse([
    ...summaries.map(thinking => ({ type: "thinking_delta", thinking }) as AdapterEvent),
    { type: "text_delta", text: "Answer.", phase: "final_answer" },
    { type: "done", endTurn: true },
  ]);

  expect(frames(body, "response.reasoning_summary_text.delta").map(raw => JSON.parse(raw).delta))
    .toEqual(summaries);
  expect(frames(body, "response.output_text.delta").map(raw => JSON.parse(raw).delta)).toEqual(["Answer."]);
});
