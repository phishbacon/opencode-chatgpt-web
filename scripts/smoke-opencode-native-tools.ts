/**
 * Upstream Codex consumes Responses function_call items through its native
 * tool harness. This isolated probe establishes that OpenCode 2.2+ also runs
 * a Responses function_call with its own tool engine and returns an actual
 * function_call_output, before adapting upstream browser/tool mediation.
 *
 * Runs a standalone OpenCode process with isolated HOME and XDG directories;
 * never reads or changes the user's OpenCode configuration or sessions.
 * Run: bun run scripts/smoke-opencode-native-tools.ts
 *      bun run scripts/smoke-opencode-native-tools.ts --invalid-tool
 *      bun run scripts/smoke-opencode-native-tools.ts --inspect-identity
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashOpenCodeWireTools, OpenCodeTurnVerifier, OPENCODE_TURN_HEADER, type OpenCodeTurnClaims } from "../src/opencode/turn-binding";
import { OpenCodeToolReceiptLedger } from "../src/opencode/tool-receipts";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

const marker = "OPENCODE_NATIVE_TOOL_RECEIPT_OK";
const finished = "OPENCODE_RESPONSES_ROUNDTRIP_OK";
const invalidTool = process.argv.includes("--invalid-tool");
const inspectIdentity = process.argv.includes("--inspect-identity");
const probeProviderID = inspectIdentity ? "opencode-chatgpt-web" : "probe";
const probeModelID = inspectIdentity ? "light" : "probe-test";
const probeModelRef = `${probeProviderID}/${probeModelID}`;
const turnKey = randomBytes(32);
const turnVerifier = new OpenCodeTurnVerifier(turnKey);
const ingressVerifier = new OpenCodeTurnVerifier(turnKey);
const issuedReceipts = new OpenCodeToolReceiptLedger();
const temporary = mkdtempSync(join(tmpdir(), "opencode-responses-proof-"));
const home = join(temporary, "home");
const configRoot = join(temporary, "config");
const project = join(temporary, "project");
const hookLog = join(temporary, "hook-records.jsonl");
const opencode = process.env.OPENCODE_BINARY ?? join(process.env.HOME ?? "", ".opencode/bin/opencode");

type Json = Record<string, unknown>;
type RequestBody = {
  model?: string;
  stream?: boolean;
  tools?: { type?: string; name?: string; description?: string; strict?: boolean; parameters?: { properties?: Json } }[];
  input?: Json[];
};

let requestCount = 0;
let sawReceipt = false;
let sawNativeCall = false;
let invalidToolRejected = false;
let toolName = "";
let lastInputTypes: string[] = [];
let firstToolNames: string[] = [];
let failure = "";
let initialBinding: { sessionID: string; messageID: string; turnNonce: string } | undefined;
const requestSummaries: { request: number; model: string; kind: string | null; inputTypes: string[]; bodyKeys: string[]; inputShapes: { type: string; keys: string[] }[]; toolChoice: unknown; metadataKeys: string[]; hasReceipt: boolean; toolNames: string[]; hookHeader: boolean; bindingVerified: boolean; ingressStatus: number | null }[] = [];
const wireToolShapes: Json[] = [];

const responseBase = (request: RequestBody, output: Json[]): Json => ({
  id: `resp_probe_${requestCount}`,
  object: "response",
  created_at: Math.floor(Date.now() / 1000),
  status: "completed",
  model: request.model ?? "probe-test",
  output,
  usage: {
    input_tokens: 40,
    output_tokens: 20,
    total_tokens: 60,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});

function responseEvents(response: Json): Json[] {
  const output = response.output as Json[];
  const events: Json[] = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } },
  ];
  for (let index = 0; index < output.length; index++) {
    const item = output[index]!;
    events.push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress" } });
    if (item.type === "function_call") {
      events.push({
        type: "response.function_call_arguments.delta",
        output_index: index,
        item_id: item.id,
        delta: item.arguments,
      });
      events.push({
        type: "response.function_call_arguments.done",
        output_index: index,
        item_id: item.id,
        arguments: item.arguments,
      });
    } else {
      const content = (item.content as Json[])[0]!;
      events.push({
        type: "response.content_part.added",
        output_index: index,
        item_id: item.id,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      events.push({
        type: "response.output_text.delta",
        output_index: index,
        item_id: item.id,
        content_index: 0,
        delta: content.text,
      });
      events.push({
        type: "response.output_text.done",
        output_index: index,
        item_id: item.id,
        content_index: 0,
        text: content.text,
      });
      events.push({
        type: "response.content_part.done",
        output_index: index,
        item_id: item.id,
        content_index: 0,
        part: content,
      });
    }
    events.push({ type: "response.output_item.done", output_index: index, item });
  }
  events.push({ type: "response.completed", response });
  return events;
}

function assistantText(text: string): Json {
  return {
    id: `msg_probe_${requestCount}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function findTool(tools: NonNullable<RequestBody["tools"]>): { name: string; arguments: string } | undefined {
  const chosen = tools.find(t => t.name && /^(bash|shell|exec_command|execute|terminal)$/.test(t.name));
  if (!chosen?.name) return;
  const keys = chosen.parameters?.properties ?? {};
  const commandKey = "command" in keys ? "command" : "cmd" in keys ? "cmd" : null;
  if (!commandKey) return;
  const args: Json = {
    [commandKey]: `printf '${marker}\\n'`,
    ...(Object.hasOwn(keys, "description") ? { description: "Verify OpenCode native tool execution" } : {}),
  };
  return { name: chosen.name, arguments: JSON.stringify(args) };
}

mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: probeModelID, object: "model" }] });
    }
    if (req.method !== "POST" || !path.endsWith("/responses")) {
      return Response.json({ error: { message: "Probe endpoint only", type: "invalid_request_error" } }, { status: 404 });
    }
    requestCount++;
    const body = await req.json() as RequestBody;
    if (inspectIdentity && wireToolShapes.length === 0 && body.tools?.length) {
      wireToolShapes.push(...body.tools.slice(0, 3).map(tool => ({
        name: tool.name,
        keys: Object.keys(tool).sort(),
        type: tool.type,
        descriptionType: typeof tool.description,
        parametersType: typeof tool.parameters,
        parameterKeys: Object.keys(tool.parameters ?? {}).sort(),
        strict: tool.strict ?? null,
      })));
    }
    const input = Array.isArray(body.input) ? body.input : [];
    lastInputTypes = input.map(item => String(item.type ?? item.role ?? "unknown"));
    const receipt = input.find(item => item.type === "function_call_output" &&
      typeof item.output === "string" && item.output.includes(marker));
    const negativeReceipt = input.find(item => item.type === "function_call_output" &&
      item.call_id === "call_native_probe" && typeof item.output === "string" &&
      /unknown|not found|does not exist|no such tool|error|invalid/i.test(item.output));
    if (negativeReceipt) invalidToolRejected = true;
    const kind = req.headers.get("x-opencode-probe-kind");
    let bindingVerified = false;
    let ingressStatus: number | null = null;
    let trustedClaims: OpenCodeTurnClaims | undefined;
    if (inspectIdentity) {
      const header = req.headers.get(OPENCODE_TURN_HEADER);
      if (kind === "primary" && header) {
        try {
          const nativeToolsHash = hashOpenCodeWireTools(body.tools);
          const claims = turnVerifier.verify(header, { model: body.model ?? "", toolsHash: nativeToolsHash });
          trustedClaims = claims;
          if (initialBinding && (claims.sessionID !== initialBinding.sessionID
            || claims.messageID !== initialBinding.messageID || claims.turnNonce !== initialBinding.turnNonce)) {
            throw new Error("OpenCode changed turn ownership during a tool continuation");
          }
          initialBinding ??= { sessionID: claims.sessionID, messageID: claims.messageID, turnNonce: claims.turnNonce };
          bindingVerified = true;
          let adapterVisited = false;
          const mirrored = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json", [OPENCODE_TURN_HEADER]: header },
            body: JSON.stringify(body),
          }), defaultConfig("browser-only"), () => ({ name: "isolated-open-code-route", async runTurn(parsed) {
            adapterVisited = parsed._openCodeTurn?.sessionID === claims.sessionID;
          } }), {
            openCodeTurnVerifier: ingressVerifier,
            openCodeToolReceipts: issuedReceipts,
          });
          ingressStatus = mirrored.status;
          // This mock checks authenticated routing; real website tool execution
          // still requires the upstream Codex browser and MCP broker path.
          if (mirrored.status !== 200 || !adapterVisited) {
            throw new Error(`Signed OpenCode ingress failed isolated adapter routing (HTTP ${mirrored.status})`);
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      } else if (kind === "primary" || header) {
        failure = "OpenCode turn binding missing or present on auxiliary request";
      }
    }
    requestSummaries.push({
      request: requestCount,
      model: body.model ?? "unknown",
      kind,
      inputTypes: [...lastInputTypes],
      bodyKeys: Object.keys(body).sort(),
      inputShapes: input.map(item => ({ type: String(item.type ?? item.role ?? "unknown"), keys: Object.keys(item).sort() })),
      toolChoice: typeof (body as Json).tool_choice === "string" ? (body as Json).tool_choice : typeof (body as Json).tool_choice,
      metadataKeys: Object.keys((body as Json).client_metadata && typeof (body as Json).client_metadata === "object" ? (body as Json).client_metadata as Json : {}).sort(),
      hasReceipt: Boolean(receipt),
      toolNames: (body.tools ?? []).map(t => t.name ?? String(t.type ?? "unknown")),
      hookHeader: req.headers.get("x-opencode-probe") === "registered-request-hook",
      bindingVerified,
      ingressStatus,
    });
    const output: Json[] = [];
    if (req.headers.get("x-opencode-probe-kind") === "title") {
      output.push(assistantText("AUXILIARY_PROVIDER_RESPONSE"));
    } else if (invalidTool && negativeReceipt) {
      output.push(assistantText("OPENCODE_UNKNOWN_TOOL_REJECTED"));
    } else if (receipt) {
      sawReceipt = true;
      output.push(assistantText(finished));
    } else if (sawNativeCall) {
      // OpenCode may request an auxiliary title or summary on this provider
      // while the tool step is in flight. Only the native receipt proves success.
      output.push(assistantText("AUXILIARY_PROVIDER_RESPONSE"));
    } else {
      const tools = Array.isArray(body.tools) ? body.tools : [];
      firstToolNames = tools.map(t => t.name ?? String(t.type ?? "unknown"));
      const tool = invalidTool ? { name: "nonexistent_probe_tool", arguments: "{}" } : findTool(tools);
      if (!tool) {
        failure = "OpenCode did not expose a supported shell tool with a command parameter";
        output.push(assistantText("NATIVE_SHELL_TOOL_NOT_OFFERED"));
      } else {
        sawNativeCall = true;
        toolName = tool.name;
        if (inspectIdentity && trustedClaims && !invalidTool) {
          // In production, the trusted website broker records each issued call
          // before OpenCode executes it, like upstream Codex's TurnBroker.
          // This mock server stands in for that broker only in this probe.
          issuedReceipts.issueBatch(trustedClaims, body.tools, [{
            callId: "call_native_probe", name: tool.name, arguments: tool.arguments,
          }]);
        }
        output.push({
          id: `fc_probe_${requestCount}`,
          type: "function_call",
          call_id: "call_native_probe",
          name: tool.name,
          arguments: tool.arguments,
          status: "completed",
        });
      }
    }
    const response = responseBase(body, output);
    if (body.stream !== false) {
      const sse = responseEvents(response).map(event =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    return Response.json(response);
  },
});

const settings = {
  providers: {
    [probeProviderID]: {
      name: "Isolated OpenCode Responses compatibility test",
      package: "@opencode/ai/providers/openai/responses",
      settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-no-secret" },
      models: {
        [probeModelID]: {
          name: "Local Responses tool probe",
          modelID: probeModelRef,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 16384, output: 1024 },
        },
      },
    },
  },
  model: probeModelRef,
  plugins: { paths: [] },
};
const configFile = join(configRoot, "opencode", "opencode.json");
mkdirSync(dirname(configFile), { recursive: true });
writeFileSync(configFile, JSON.stringify(settings), { mode: 0o600 });
if (inspectIdentity) {
  const pluginDir = join(configRoot, "opencode", "plugins");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "actual-turn-binding.js"), `
import { createOpenCodeIdentityPlugin } from ${JSON.stringify(`file://${join(import.meta.dir, "../src/opencode/identity-plugin.ts")}`)};
export default createOpenCodeIdentityPlugin({ providerID: ${JSON.stringify(probeProviderID)}, key: process.env.HARNESS_TURN_KEY });
`, { mode: 0o600 });
  writeFileSync(join(pluginDir, "identity-probe.js"), `
import { appendFileSync } from "node:fs";
function log(kind, event) {
  const record = {
    hook: kind,
    keys: Object.keys(event ?? {}).sort(),
    fields: Object.fromEntries(
      ["sessionID", "turnID", "messageID", "providerID", "modelID", "stepID", "kind", "role", "type"]
        .map(key => [key, typeof event?.[key] === "string" && ["kind", "role", "type"].includes(key) ? event[key] : typeof event?.[key]])
    ),
  };
  appendFileSync(process.env.HARNESS_PROBE_LOG, JSON.stringify(record) + "\\n");
}
export default {
  id: "isolated-identity-probe",
  async setup(ctx) {
    await ctx.session.hook("prompt", event => log("prompt", event));
    await ctx.session.hook("context", event => {
      log("context", event);
      // Log structural evidence only: no prompt text, paths, arguments or secrets.
      appendFileSync(process.env.HARNESS_PROBE_LOG, JSON.stringify({
        hook: "context.shape",
        agentType: typeof event.agent,
        optionsType: typeof event.options,
        optionKeys: Object.keys(event.options ?? {}).sort(),
        modelType: typeof event.model,
        modelKeys: Object.keys(event.model ?? {}).sort(),
        toolsType: typeof event.tools,
        toolsIsArray: Array.isArray(event.tools),
        toolsCount: Array.isArray(event.tools) ? event.tools.length : Object.keys(event.tools ?? {}).length,
        toolNames: Array.isArray(event.tools)
          ? event.tools.map(tool => typeof tool?.name === "string" ? tool.name : "unknown").sort()
          : Object.keys(event.tools ?? {}).sort(),
        toolValueShapes: Object.entries(event.tools ?? {}).slice(0, 3).map(([name, value]) => ({
          name,
          valueType: typeof value,
          keys: value && typeof value === "object" ? Object.keys(value).sort() : [],
          descriptionType: typeof value?.description,
          parametersType: typeof value?.parameters,
          inputType: typeof value?.input,
          inputKeys: value?.input && typeof value.input === "object" ? Object.keys(value.input).sort() : [],
          inputProperties: value?.input?.properties && typeof value.input.properties === "object"
            ? Object.keys(value.input.properties).sort() : [],
          parametersKeys: value?.parameters && typeof value.parameters === "object"
            ? Object.keys(value.parameters).sort() : [],
          inputSchemaType: typeof value?.inputSchema,
          schemaType: typeof value?.schema,
        })),
        messagesCount: Array.isArray(event.messages) ? event.messages.length : null,
        systemCount: Array.isArray(event.system) ? event.system.length : null,
      }) + "\\n");
    });
    await ctx.session.hook("context", async event => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      // Inspect only typed shapes and comparisons, never workspace paths or permission rules.
      appendFileSync(process.env.HARNESS_PROBE_LOG, JSON.stringify({
        hook: "trusted.session",
        idMatches: session?.id === event.sessionID,
        sessionKeys: Object.keys(session ?? {}).sort(),
        locationKeys: Object.keys(session?.location ?? {}).sort(),
        absoluteDirectory: typeof session?.location?.directory === "string" && session.location.directory.startsWith("/"),
        locationMatchesPlugin: session?.location?.directory === ctx.location?.directory,
        projectType: typeof session?.projectID,
        agentType: typeof session?.agent,
        permissionsArray: Array.isArray(session?.permissions),
      }) + "\\n");
    });
    await ctx.session.hook("model.request", event => {
      const inspect = {
        hook: "model.request",
        keys: Object.keys(event).sort(),
        fields: Object.fromEntries(
          ["sessionID", "turnID", "messageID", "providerID", "modelID", "stepID"]
            .map(key => [key, typeof event[key]])
        ),
        modelKeys: Object.keys(event.model ?? {}).sort(),
        modelId: event.model?.id,
        providerId: event.model?.providerID,
        optionsKeys: Object.keys(event.options ?? {}).sort(),
        headersKeys: Object.keys(event.headers ?? {}).sort(),
        kind: event.kind,
      };
      appendFileSync(process.env.HARNESS_PROBE_LOG, JSON.stringify(inspect) + "\\n");
      event.headers["x-opencode-probe"] = "registered-request-hook";
      event.headers["x-opencode-probe-kind"] = event.kind;
    }, { providerID: ${JSON.stringify(probeProviderID)} });
  },
};
`, { mode: 0o600 });
}

let exitCode = 1;
try {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configRoot,
    XDG_DATA_HOME: join(temporary, "data"),
    XDG_CACHE_HOME: join(temporary, "cache"),
    XDG_STATE_HOME: join(temporary, "state"),
    PATH: [join(dirname(opencode), ".."), dirname(process.execPath), process.env.PATH ?? ""].join(":"),
    HARNESS_PROBE_LOG: hookLog,
    HARNESS_TURN_KEY: turnKey.toString("hex"),
  };
  // Do not inherit project-specific provider overrides into isolated runtime.
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_") && key !== "OPENCODE_BINARY") delete env[key];
  const child = Bun.spawn({
    cmd: [opencode, "run", "--standalone", "--format", "json", "--model", probeModelRef,
      "Execute the shell command supplied by the model tool call, then report its result."],
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>(resolve => {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      void child.exited.then(resolve);
    }, 50_000);
  });
  const code = await Promise.race([child.exited, timeout]);
  clearTimeout(timeoutTimer);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const hookRecords = existsSync(hookLog)
    ? readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x) as Json)
    : [];
  const foundFinal = stdout.includes(invalidTool ? "OPENCODE_UNKNOWN_TOOL_REJECTED" : finished);
  const explicitRejection = invalidToolRejected || /no such tool|unknown tool|tool not found|invalid tool|not found in available tools/i.test(stdout);
  exitCode = invalidTool
    ? Number(timedOut || !sawNativeCall || !explicitRejection)
    : Number(timedOut || code !== 0 || !sawNativeCall || !sawReceipt || !foundFinal || Boolean(failure));
  if (inspectIdentity && (hookRecords.length === 0 || requestSummaries.some(x =>
    !x.hookHeader || x.bindingVerified !== (x.kind === "primary")
      || x.ingressStatus !== (x.kind === "primary" ? 200 : null)))) exitCode = 1;
  console.log(JSON.stringify({
    status: exitCode === 0 ? "PASS" : "FAIL",
    mode: invalidTool ? "reject-unavailable-tool" : "native-shell-tool-roundtrip",
    exitCode: code,
    timedOut,
    requests: requestCount,
    exposedTools: firstToolNames,
    selectedTool: toolName,
    functionCallEmitted: sawNativeCall,
    receiptReturnedToProvider: sawReceipt,
    invalidToolRejected,
    finalShownInOpenCode: foundFinal,
    lastInputTypes,
    requestSummaries,
    ...(inspectIdentity ? { hookRecords } : {}),
    ...(inspectIdentity ? { wireToolShapes } : {}),
    ...(failure ? { failure } : {}),
    ...(exitCode === 1 ? { stdoutTail: stdout.slice(-1800), stderrTail: stderr.slice(-1800) } : {}),
  }, null, 2));
} finally {
  server.stop(true);
  rmSync(temporary, { recursive: true, force: true });
}
process.exitCode = exitCode;
