/**
 * The upstream Codex harness routes ChatGPT website MCP calls through its native
 * Codex tool registry. OpenCode reuses its stdio MCP server and turn broker but
 * exposes only the authenticated OpenCode turn's tools to the same browser path.
 * These tests verify the separate connector and original native boundary.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverOpenCodeToolResult } from "../src/adapters/chatgpt-web/index";
import { callTurnBroker, MAX_TURN_MCP_ACTIVITY_IDS, RemoteTurnBroker, TurnBroker, TurnBrokerTimeoutError } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const shell = { name: "shell", description: "Execute a command in the originating session", parameters: {
  type: "object", properties: { command: { type: "string" } }, required: ["command"],
} };
const read = { name: "read", description: "Read a file in the originating workspace", parameters: {
  type: "object", properties: { filePath: { type: "string" } },
} };
const patch = { name: "patch", description: "Apply a patch", freeform: true, parameters: {} };
const search = { name: "tool_search", description: "Discover deferred tools", toolSearch: true, parameters: {
  type: "object", properties: { query: { type: "string" } },
} };
// Mirrors OpenCode's declared subagent schema, including the native background field the
// transport must strip and hide from advertised schemas.
const subagent = { name: "subagent", description: "Run a subagent for this task", parameters: {
  type: "object", properties: {
    agent: { type: "string" }, description: { type: "string" }, prompt: { type: "string" },
    model: { type: "string" }, sessionID: { type: "string" }, background: { type: "boolean" },
  }, required: ["agent", "description", "prompt"],
} };

function environment(origin?: "opencode", extraTools: ChatGptTurnEnvironment["tools"] = []): ChatGptTurnEnvironment {
  return {
    ...(origin ? { origin } : {}),
    cwd: process.cwd(),
    roots: [process.cwd()],
    writableRoots: [process.cwd()],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false },
    tools: [shell, read, patch, search, {
      name: "lookup", namespace: "mcp__fixture", description: "Find fixture entries", parameters: { type: "object" },
    }, ...extraTools],
  };
}

let sequence = 0;
async function fixture(contract: "native" | "opencode" = "opencode", spawnEnv: Record<string, string> = {}) {
  const endpointName = `oc-mcp-${process.pid}-${++sequence}`;
  const socketPath = process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), endpointName), "win32")
    : join(tmpdir(), `${endpointName}.sock`);
  const broker = TurnBroker.forSocket(socketPath);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socketPath],
    cwd: process.cwd(),
    // Inherit stderr: an undrained "pipe" fills its buffer and blocks the MCP
    // child on Windows, which stalls the initialize handshake indefinitely.
    stderr: "inherit",
    env: { ...process.env, ...spawnEnv } as Record<string, string>,
  });
  const client = new Client({ name: "opencode-website-contract-test", version: "1" });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const close = async () => {
    await client.close().catch(() => {});
    await broker.close();
  };
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        handshakeTimer = setTimeout(
          () => reject(new Error("MCP stdio initialize handshake timed out")),
          20_000,
        );
      }),
    ]).finally(() => clearTimeout(handshakeTimer));
  } catch (error) {
    await close();
    throw error;
  }
  return { broker, client, call, close };
}

describe("OpenCode website MCP contract", () => {
  test("lists only the OpenCode API and returns exact originating tool inventory", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    try {
      expect((await f.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        "opencode_subagent_wait", "opencode_tool_call", "opencode_tool_inventory",
      ]);
      const all = await f.call("opencode_tool_inventory", { turn_token: token, limit: 2 });
      expect(all.structuredContent).toMatchObject({
        total: 5, next_offset: 2,
        tools: [{ wire_name: "shell", kind: "function" }, { wire_name: "read", kind: "function" }],
      });
      const others = await f.call("opencode_tool_inventory", { turn_token: token, offset: 2, limit: 3 });
      expect(others.structuredContent).toMatchObject({
        total: 5, next_offset: null,
        tools: [
          { wire_name: "patch", kind: "freeform" },
          { wire_name: "tool_search", kind: "tool_search" },
          { wire_name: "mcp__fixture__lookup", kind: "function" },
        ],
      });
      const query = await f.call("opencode_tool_inventory", { turn_token: token, query: "missing tool", include_schema: false });
      expect(query.structuredContent).toMatchObject({
        total: 0, tools: [], discovery_tools: [{ wire_name: "tool_search" }],
      });
      expect(JSON.stringify(query)).not.toContain("bindingId");
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("bounds retained activity IDs while preserving retries and completion tombstones", async () => {
    const endpointName = `oc-activity-cap-${process.pid}-${Date.now()}`;
    const socketPath = process.platform === "win32"
      ? defaultBrokerEndpoint(join(tmpdir(), endpointName), "win32")
      : join(tmpdir(), `${endpointName}.sock`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(environment("opencode"), 60_000);
    const activeActivityId = "activity_active_0000000000000001";
    try {
      const first = await callTurnBroker<{ bindingId: string }>(socketPath, {
        method: "claim", contract: "opencode", token, activityId: activeActivityId,
      });
      for (let index = 0; index < MAX_TURN_MCP_ACTIVITY_IDS - 1; index += 1) {
        await callTurnBroker(socketPath, {
          method: "activity_complete", token,
          activityId: `activity_done_${String(index).padStart(16, "0")}`,
        });
      }

      const retry = await callTurnBroker<{ bindingId: string }>(socketPath, {
        method: "claim", contract: "opencode", token, activityId: activeActivityId,
      });
      expect(retry.bindingId).toBe(first.bindingId);
      await expect(callTurnBroker(socketPath, {
        method: "claim", contract: "opencode", token, activityId: "activity_new_0000000000000001",
      })).rejects.toThrow("turn activity capacity exceeded");
      await expect(callTurnBroker(socketPath, {
        method: "activity_complete", token, activityId: "activity_missing_0000000000000001",
      })).rejects.toThrow("turn activity capacity exceeded");

      await expect(callTurnBroker<{ completed: boolean }>(socketPath, {
        method: "activity_complete", token, activityId: activeActivityId,
      })).resolves.toEqual({ completed: true });
      await expect(callTurnBroker(socketPath, {
        method: "activity_complete", token, activityId: activeActivityId,
      })).resolves.toEqual({ completed: false, duplicate: true });
      await expect(callTurnBroker(socketPath, {
        method: "claim", contract: "opencode", token, activityId: "activity_after_0000000000000001",
      })).rejects.toThrow("turn activity capacity exceeded");
    } finally {
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);

  test("routes structured, freeform and concurrent calls to only the bound OpenCode tools", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    try {
      const first = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "pwd" },
      });
      const second = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "read", arguments: { filePath: "note.txt" },
      });
      const batch = await f.broker.nextToolBatch(token);
      expect(batch).toHaveLength(2);
      expect(batch.map(tool => ({ name: tool.wireName, args: tool.arguments, freeform: tool.freeform }))).toEqual([
        { name: "shell", args: { command: "pwd" }, freeform: false },
        { name: "read", args: { filePath: "note.txt" }, freeform: false },
      ]);
      for (const request of batch) {
        f.broker.completeTool(token, request.callId, { content: [{ type: "text", text: request.wireName }], structuredContent: { tool: request.wireName } });
      }
      expect((await first).structuredContent).toEqual({ tool: "shell" });
      expect((await second).structuredContent).toEqual({ tool: "read" });

      const freeform = f.call("opencode_tool_call", { turn_token: token, wire_name: "patch", input: "*** patch ***" });
      const outcome = await Promise.race([
        f.broker.nextToolBatch(token).then(batch => ({ kind: "dispatched" as const, batch })),
        freeform.then(response => ({ kind: "preflight" as const, response })),
      ]);
      if (outcome.kind === "preflight") throw new Error(`Freeform request was rejected before broker dispatch: ${JSON.stringify(outcome.response)}`);
      const [request] = outcome.batch;
      expect(request).toMatchObject({ wireName: "patch", freeform: true, input: "*** patch ***" });
      f.broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "approved" }] });
      expect((await freeform).content).toEqual([{ type: "text", text: "approved" }]);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("accepts a lost completion acknowledgment only for identical OpenCode results", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    const otherToken = await f.broker.register(environment("opencode"), 60_000);
    try {
      const website = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo once" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      const result = { content: [{ type: "text", text: "ran once" }] };
      const remote = new RemoteTurnBroker(f.broker.socketPath);
      // Simulate a lost owner_complete response after the broker committed the result.
      await remote.completeTool(token, request!.callId, result);
      await expect(remote.completeTool(token, request!.callId, result)).resolves.toBeUndefined();
      await expect(remote.completeTool(token, request!.callId, { content: [{ type: "text", text: "different" }] }))
        .rejects.toThrow("previously completed OpenCode tool result changed");
      await expect(remote.completeTool(otherToken, request!.callId, result)).rejects.toThrow("not pending");
      await expect(remote.completeTool(token, "call_not_issued", result)).rejects.toThrow("not pending");
      expect((await website).content).toEqual(result.content);
      f.broker.revoke(token);
      await expect(remote.completeTool(token, request!.callId, result)).rejects.toThrow("invalid or expired");
    } finally {
      f.broker.revoke(token);
      f.broker.revoke(otherToken);
      await f.close();
    }
  }, 15_000);

  test("recovers an interrupted parallel result batch without reissuing website tools", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    try {
      const websiteFirst = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo once" },
      });
      const websiteSecond = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "read", arguments: { filePath: "note.txt" },
      });
      const batch = await f.broker.nextToolBatch(token);
      expect(batch).toHaveLength(2);
      const remote = new RemoteTurnBroker(f.broker.socketPath);
      const complete = remote.completeTool.bind(remote);
      const attempts: string[] = [];
      let failAfterCommit = true;
      remote.completeTool = async (ownerToken, callId, result) => {
        attempts.push(callId);
        await complete(ownerToken, callId, result);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new TurnBrokerTimeoutError();
        }
      };
      for (const request of batch) {
        await deliverOpenCodeToolResult(remote, token, request.callId, {
          content: [{ type: "text", text: request.wireName }],
        });
      }
      expect(attempts).toEqual([batch[0]!.callId, batch[0]!.callId, batch[1]!.callId]);
      expect((await websiteFirst).content).toEqual([{ type: "text", text: "shell" }]);
      expect((await websiteSecond).content).toEqual([{ type: "text", text: "read" }]);
      // Each website call settles once; the retry only repeats its result acknowledgment.
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("recovers when the real broker socket drops a committed result acknowledgment", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    // Upstream Codex completes a call once. OpenCode must replay a native result over
    // a new owner socket when the original ACK was lost after broker acceptance.
    const socketOwner = f.broker as unknown as {
      writeSocketResponse: (socket: Socket, response: { result?: unknown }) => void;
    };
    const originalWrite = socketOwner.writeSocketResponse;
    let acknowledgmentsDropped = 0;
    socketOwner.writeSocketResponse = (socket, response) => {
      if (acknowledgmentsDropped === 0 && (response.result as { completed?: boolean } | undefined)?.completed === true) {
        acknowledgmentsDropped++;
        socket.destroy();
        return;
      }
      originalWrite.call(f.broker, socket, response);
    };
    try {
      const website = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo once" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, request!.callId, {
        content: [{ type: "text", text: "executed once" }],
      });
      expect(acknowledgmentsDropped).toBe(1);
      expect((await website).content).toEqual([{ type: "text", text: "executed once" }]);
    } finally {
      socketOwner.writeSocketResponse = originalWrite;
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("keeps original OpenCode completion single-shot", async () => {
    const f = await fixture("native");
    const token = await f.broker.register(environment(), 60_000);
    try {
      const website = f.call("codex_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "pwd" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      const result = { content: [{ type: "text", text: "done" }] };
      f.broker.completeTool(token, request!.callId, result);
      expect(() => f.broker.completeTool(token, request!.callId, result)).toThrow("not pending");
      expect((await website).content).toEqual(result.content);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("rejects unavailable tools, wrong payload kinds and revoked capabilities", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 60_000);
    try {
      for (const invalid of [
        { wire_name: "unadvertised", arguments: {} },
        { wire_name: "patch", arguments: { unexpected: true } },
        { wire_name: "patch", input: "text", arguments: { unexpected: true } },
        { wire_name: "shell", input: "pwd" },
      ]) {
        const denied = await f.call("opencode_tool_call", { turn_token: token, ...invalid });
        expect(denied.isError).toBe(true);
      }
      const invalidToken = await f.call("opencode_tool_inventory", { turn_token: `turn_${"x".repeat(32)}` });
      expect(invalidToken.isError).toBe(true);
      f.broker.revoke(token);
      const revoked = await f.call("opencode_tool_call", { turn_token: token, wire_name: "shell", arguments: { command: "pwd" } });
      expect(revoked.isError).toBe(true);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("keeps authenticated OpenCode turns separated from upstream OpenCode connector", async () => {
    const [openCode, codex] = await Promise.all([fixture("opencode"), fixture("native")]);
    const openCodeToken = await openCode.broker.register(environment("opencode"), 60_000);
    const codexToken = await codex.broker.register(environment(), 60_000);
    try {
      const foreignToOpenCode = await openCode.call("opencode_tool_inventory", { turn_token: codexToken });
      expect(foreignToOpenCode.isError).toBe(true);
      const foreignToCodex = await codex.call("codex_tool_inventory", { turn_token: openCodeToken });
      expect(foreignToCodex.isError).toBe(true);
      expect((await openCode.call("opencode_tool_inventory", { turn_token: openCodeToken })).structuredContent)
        .toMatchObject({ total: 5 });
    } finally {
      openCode.broker.revoke(openCodeToken);
      codex.broker.revoke(codexToken);
      await Promise.all([openCode.close(), codex.close()]);
    }
  }, 15_000);

  test("isolates tool inventories and execution within two turns on the same broker", async () => {
    const f = await fixture();
    const firstEnvironment = environment("opencode");
    const secondEnvironment = environment("opencode");
    secondEnvironment.tools = [read];
    const [firstToken, secondToken] = await Promise.all([
      f.broker.register(firstEnvironment, 60_000),
      f.broker.register(secondEnvironment, 60_000),
    ]);
    try {
      const firstTools = await f.call("opencode_tool_inventory", { turn_token: firstToken });
      const secondTools = await f.call("opencode_tool_inventory", { turn_token: secondToken });
      expect(firstTools.structuredContent).toMatchObject({ total: 5 });
      expect(secondTools.structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: "read" }] });
      const crossTurn = await f.call("opencode_tool_call", {
        turn_token: secondToken, wire_name: "shell", arguments: { command: "pwd" },
      });
      expect(crossTurn.isError).toBe(true);

      const first = f.call("opencode_tool_call", {
        turn_token: firstToken, wire_name: "shell", arguments: { command: "pwd" },
      });
      const second = f.call("opencode_tool_call", {
        turn_token: secondToken, wire_name: "read", arguments: { filePath: "note.txt" },
      });
      const [firstBatch, secondBatch] = await Promise.all([
        f.broker.nextToolBatch(firstToken), f.broker.nextToolBatch(secondToken),
      ]);
      expect(firstBatch).toHaveLength(1);
      expect(firstBatch[0]?.wireName).toBe("shell");
      expect(secondBatch).toHaveLength(1);
      expect(secondBatch[0]?.wireName).toBe("read");
      expect(() => f.broker.completeTool(secondToken, firstBatch[0]!.callId, { content: [] }))
        .toThrow("tool call is not pending");
      expect(() => f.broker.completeTool(firstToken, secondBatch[0]!.callId, { content: [] }))
        .toThrow("tool call is not pending");
      f.broker.completeTool(firstToken, firstBatch[0]!.callId, { content: [{ type: "text", text: "shell" }] });
      f.broker.completeTool(secondToken, secondBatch[0]!.callId, { content: [{ type: "text", text: "read" }] });
      expect((await first).content).toEqual([{ type: "text", text: "shell" }]);
      expect((await second).content).toEqual([{ type: "text", text: "read" }]);
    } finally {
      f.broker.revoke(firstToken);
      f.broker.revoke(secondToken);
      await f.close();
    }
  }, 15_000);

  test("expires OpenCode website capabilities before inventory or invocation", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 1);
    try {
      await Bun.sleep(35);
      expect((await f.call("opencode_tool_inventory", { turn_token: token })).isError).toBe(true);
      expect((await f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "pwd" },
      })).isError).toBe(true);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("keeps a claimed OpenCode website turn alive while a native tool runs", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode"), 300);
    try {
      // Codex keeps its native tool channel alive for the running turn. OpenCode
      // must likewise outlive the registration window after an MCP claim.
      expect((await f.call("opencode_tool_inventory", { turn_token: token })).structuredContent)
        .toMatchObject({ total: 5 });
      await Bun.sleep(350);
      const website = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo finished" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      expect(request?.wireName).toBe("shell");
      await Bun.sleep(40);
      f.broker.completeTool(token, request!.callId, {
        content: [{ type: "text", text: "completed" }],
      });
      expect((await website).content).toEqual([{ type: "text", text: "completed" }]);
      f.broker.revoke(token);
      expect((await f.call("opencode_tool_inventory", { turn_token: token })).isError).toBe(true);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("settles a slow subagent as a running handle and later collects its native result", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const started = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Trace a thing", prompt: "Find the root cause" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      expect(request?.wireName).toBe("subagent");
      const handle = (await started).structuredContent as { status?: string; id?: string };
      expect(handle.status).toBe("running");
      expect(handle.id).toBe(request!.callId);
      const stillRunning = await f.call("opencode_subagent_wait", { turn_token: token, id: handle.id! });
      expect(stillRunning.isError).toBeUndefined();
      expect(stillRunning.structuredContent).toMatchObject({ status: "running", id: handle.id! });
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, request!.callId, {
        content: [{ type: "text", text: "child finished" }],
        structuredContent: { sessionID: "ses_child123", status: "completed", output: "child finished" },
      });
      const completed = await f.call("opencode_subagent_wait", { turn_token: token, id: handle.id! });
      expect(completed.isError).toBeUndefined();
      expect(completed.structuredContent).toEqual({ sessionID: "ses_child123", status: "completed", output: "child finished" });
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("returns the native result inline when the subagent finishes within the grace", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "2000",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const started = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Fast thing", prompt: "Finish quickly" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, request!.callId, {
        content: [{ type: "text", text: "fast" }],
        structuredContent: { sessionID: "ses_child456", status: "completed", output: "fast" },
      });
      const inline = await started;
      expect(inline.structuredContent).toEqual({ sessionID: "ses_child456", status: "completed", output: "fast" });
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("runs parallel subagent spawns with independent ids and collects them independently", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const first = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "First trace", prompt: "Trace the notification path" },
      });
      const second = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Second trace", prompt: "Trace the click handler" },
      });
      const batch = await f.broker.nextToolBatch(token);
      expect(batch).toHaveLength(2);
      const [one, two] = batch;
      expect(one!.callId).not.toBe(two!.callId);
      // The first child is still unexecuted: its wait reports running.
      const runningFirst = await f.call("opencode_subagent_wait", { turn_token: token, id: one!.callId });
      expect(runningFirst.structuredContent).toMatchObject({ status: "running", id: one!.callId });
      // Results arrive in reverse order; each collect resolves only its own id.
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, two!.callId, {
        content: [{ type: "text", text: "second done" }],
      });
      const secondDone = await f.call("opencode_subagent_wait", { turn_token: token, id: two!.callId });
      expect(secondDone.isError).toBeUndefined();
      expect(secondDone.content).toEqual([{ type: "text", text: "second done" }]);
      expect((await f.call("opencode_subagent_wait", { turn_token: token, id: one!.callId })).structuredContent)
        .toMatchObject({ status: "running" });
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, one!.callId, {
        content: [{ type: "text", text: "first done" }],
      });
      const firstDone = await f.call("opencode_subagent_wait", { turn_token: token, id: one!.callId });
      expect(firstDone.content).toEqual([{ type: "text", text: "first done" }]);
      const startedFirst = await first;
      expect(startedFirst.structuredContent).toMatchObject({ id: one!.callId });
      await second;
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("returns the existing handle for an identical pending subagent spawn", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const args = { agent: "explore", description: "Duplicate probe", prompt: "Investigate the duplicate guard" };
      const first = f.call("opencode_tool_call", { turn_token: token, wire_name: "subagent", arguments: args });
      const [request] = await f.broker.nextToolBatch(token);
      expect(((await first).structuredContent as { id?: string }).id).toBe(request!.callId);
      const duplicate = f.call("opencode_tool_call", { turn_token: token, wire_name: "subagent", arguments: { ...args } });
      expect(((await duplicate).structuredContent as { id?: string }).id).toBe(request!.callId);
      // A different prompt is a different run: its handle carries a fresh call id, which
      // also proves the dedup key matched only the identical pending spawn.
      const distinct = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent", arguments: { ...args, prompt: "A different investigation" },
      });
      expect(((await distinct).structuredContent as { id?: string }).id).not.toBe(request!.callId);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("strips a model-passed background flag before relaying subagent to OpenCode", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const started = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Background probe", prompt: "Run detached", background: true },
      });
      const [request] = await f.broker.nextToolBatch(token);
      expect(request?.arguments).not.toHaveProperty("background");
      expect(request?.arguments).toMatchObject({
        agent: "explore", description: "Background probe", prompt: "Run detached",
      });
      await started;
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("fails collect explicitly for unknown ids and for retired turns", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const bogus = await f.call("opencode_subagent_wait", { turn_token: token, id: `call_${"z".repeat(32)}` });
      expect(bogus.isError).toBe(true);
      expect((bogus.content as Array<{ type: string; text: string }>)[0])
        .toMatchObject({ type: "text", text: expect.stringContaining("unknown subagent id") });
      const started = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Doomed", prompt: "Will be revoked" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      await started;
      f.broker.revoke(token);
      const afterRetire = await f.call("opencode_subagent_wait", { turn_token: token, id: request!.callId });
      expect(afterRetire.isError).toBe(true);
      expect((afterRetire.content as Array<{ text: string }>)[0]!.text).toMatch(/expired|invalid|already finished/i);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("retires the turn when a pending subagent exceeds its total cap", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_PENDING_TIMEOUT_MS: "250",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const started = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Hung child", prompt: "Never finishes" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      await started;
      const before = await f.call("opencode_subagent_wait", { turn_token: token, id: request!.callId });
      expect(before.structuredContent).toMatchObject({ status: "running" });
      await Bun.sleep(400); // grace (50) + cap (250) elapse → the turn retires itself
      const after = await f.call("opencode_subagent_wait", { turn_token: token, id: request!.callId });
      expect(after.isError).toBe(true);
      expect((after.content as Array<{ text: string }>)[0]!.text).toMatch(/expired|invalid|already finished/i);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("advertises the subagent wait protocol without the native background mode", async () => {
    const f = await fixture();
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const inventory = await f.call("opencode_tool_inventory", { turn_token: token, include_schema: true, limit: 50 });
      const payload = inventory.structuredContent as {
        tools: Array<{ wire_name: string; description: string; parameters?: { properties?: Record<string, unknown>; required?: unknown[] } }>;
      };
      const entry = payload.tools.find(tool => tool.wire_name === "subagent");
      expect(entry).toBeDefined();
      expect(entry!.description).toContain("opencode_subagent_wait");
      expect(entry!.description).toContain("never set background");
      expect(entry!.parameters?.properties).not.toHaveProperty("background");
      expect(entry!.parameters?.properties).toHaveProperty("model");
      expect(entry!.parameters?.properties).toHaveProperty("sessionID");
      expect(entry!.parameters?.required).toEqual(["agent", "description", "prompt"]);
      // The wait tool is a first-class bridge tool, not an inventory entry.
      expect(payload.tools.some(tool => tool.wire_name === "opencode_subagent_wait")).toBe(false);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);

  test("rejects other tool calls while a subagent is pending and recovers after it completes", async () => {
    const f = await fixture("opencode", {
      CODEX_CHATGPT_WEB_SUBAGENT_SPAWN_GRACE_MS: "50",
      CODEX_CHATGPT_WEB_SUBAGENT_COLLECT_WAIT_MS: "50",
    });
    const token = await f.broker.register(environment("opencode", [subagent]), 60_000);
    try {
      const spawned = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "subagent",
        arguments: { agent: "explore", description: "Hold", prompt: "Hold the turn open" },
      });
      const [request] = await f.broker.nextToolBatch(token);
      expect(((await spawned).structuredContent as { status?: string }).status).toBe("running");
      // OpenCode is blocked on the subagent: any other tool would queue past the
      // transport deadline and retire the turn, so it is rejected explicitly.
      const blocked = await f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo nope" },
      });
      expect(blocked.isError).toBe(true);
      expect((blocked.content as Array<{ text: string }>)[0]!.text).toContain("opencode_subagent_wait");
      // The turn binding survives the rejection, and once the subagent's result
      // lands the normal tool path works again.
      await deliverOpenCodeToolResult(new RemoteTurnBroker(f.broker.socketPath), token, request!.callId, {
        content: [{ type: "text", text: "done" }],
      });
      const shell = f.call("opencode_tool_call", {
        turn_token: token, wire_name: "shell", arguments: { command: "echo ok" },
      });
      const [shellRequest] = await f.broker.nextToolBatch(token);
      expect(shellRequest?.wireName).toBe("shell");
      f.broker.completeTool(token, shellRequest!.callId, { content: [{ type: "text", text: "ok" }] });
      expect((await shell).content).toEqual([{ type: "text", text: "ok" }]);
    } finally {
      f.broker.revoke(token);
      await f.close();
    }
  }, 15_000);
});
