/**
 * Upstream Codex supplies its own signed-in native turn identity and context
 * to the Responses bridge. OpenCode instead supplies trusted V2 prompt and
 * primary model-request hooks; this plugin signs their identity for the same
 * downstream browser-turn ownership model. It also reads the originating
 * session's own location/project, never the plugin load location, so a shared
 * plugin cannot accidentally bind a turn to another OpenCode worktree.
 * OpenCode still grants or denies every tool permission.
 */
import {
  OpenCodeTurnIssuer, OPENCODE_TURN_HEADER, parseTurnSigningKey,
  type OpenCodeTurnOwner,
} from "./turn-binding";
import { sendOpenCodeSessionDeletion, signOpenCodeSessionDeletion } from "./session-lifecycle";
import { readFileSync } from "node:fs";

/**
 * Installing into an existing OpenCode configuration must not copy the bridge
 * signing secret a second time, so the plugin can read it from the DEV host's
 * private key file instead of the environment.
 */
function readSigningKeyFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`OpenCode chatgpt-web signing key file is unreadable: ${path}`);
  }
}

interface RuntimeHookContext {
  location: { directory: string; workspaceID?: string };
  event: { subscribe(options: { signal: AbortSignal }): AsyncIterable<{
    type: string;
    data?: { sessionID?: string };
    location?: { directory?: string; workspaceID?: string };
  }> };
  session: {
    hook(name: "prompt", callback: (event: { sessionID: string; messageID: string }) => void): Promise<unknown>;
    hook(name: "context", callback: (event: {
      sessionID: string;
      agent: string;
      model: { id: string; providerID: string };
      tools: Record<string, unknown>;
    }) => Promise<void> | void): Promise<unknown>;
    hook(name: "model.request", callback: (event: {
      sessionID: string;
      kind: string;
      model: { id: string; providerID: string };
      headers: Record<string, string>;
    }) => void | Promise<void>, options: { providerID: string }): Promise<unknown>;
    get(input: { sessionID: string }): Promise<{
      id: string;
      location?: { directory?: string };
      projectID?: string;
    }>;
  };
}

/**
 * The launcher will provision a distinct signing key to this host OpenCode
 * plugin and its local bridge. Missing keys fail only on the selected provider;
 * other configured OpenCode models are unaffected.
 */
export function createOpenCodeIdentityPlugin(options: {
  providerID?: string;
  key?: string;
  keyFile?: string;
  bridgeURL?: string;
  sendDeletion?: typeof sendOpenCodeSessionDeletion;
} = {}) {
  const providerID = options.providerID ?? "opencode-chatgpt-web";
  let issuer: OpenCodeTurnIssuer | undefined;
  const prompts = new Map<string, string>();
  const activated = new Map<string, string>();
  const owners = new Map<string, OpenCodeTurnOwner>();
  const signingKey = () => parseTurnSigningKey(
    options.key ?? (options.keyFile !== undefined
      ? readSigningKeyFile(options.keyFile)
      : process.env.OPENCODE_CHATGPT_WEB_TURN_KEY),
  );
  const getIssuer = () => issuer ??= new OpenCodeTurnIssuer(
    signingKey(),
  );
  // OpenCode dispatches the continuation in the same tick as (sometimes one
  // tick before) its compaction-ended event. Signing that continuation before
  // the epoch advances makes the bridge reject it as dropped tool history, so
  // primary requests wait for the in-flight compaction to settle first.
  const compactionGates = new Map<string, { promise: Promise<void>; release: () => void; timer: ReturnType<typeof setTimeout> }>();
  const openCompactionGate = (sessionID: string) => {
    if (compactionGates.has(sessionID)) return;
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    const timer = setTimeout(() => { compactionGates.delete(sessionID); release(); }, 30_000);
    compactionGates.set(sessionID, { promise, release, timer });
  };
  const closeCompactionGate = (sessionID: string) => {
    const gate = compactionGates.get(sessionID);
    if (!gate) return;
    clearTimeout(gate.timer);
    compactionGates.delete(sessionID);
    gate.release();
  };
  const activatePrompt = (sessionID: string) => {
    const prompt = prompts.get(sessionID);
    if (prompt && prompt !== activated.get(sessionID)) {
      getIssuer().beginPrompt(sessionID, prompt);
      activated.set(sessionID, prompt);
    }
  };

  return {
    id: "opencode-chatgpt-web-identity",
    async setup(ctx: RuntimeHookContext) {
      // Codex detects compaction from its own rollout. OpenCode signals it from
      // the trusted V2 event stream; only the matching workspace may advance
      // a session's signed epoch or retire its source-side identity.
      const controller = new AbortController();
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.location?.directory !== ctx.location.directory
            || event.location.workspaceID !== ctx.location.workspaceID) continue;
          const sessionID = event.data?.sessionID;
          if (!sessionID) continue;
          if (event.type === "session.compaction.started") {
            openCompactionGate(sessionID);
          } else if (event.type === "session.compaction.ended" || event.type === "session.compacted") {
            issuer?.noteCompaction(sessionID);
            closeCompactionGate(sessionID);
          } else if (event.type === "session.compaction.failed") {
            closeCompactionGate(sessionID);
          } else if (event.type === "session.deleted") {
            issuer?.retire(sessionID);
            prompts.delete(sessionID);
            activated.delete(sessionID);
            const owner = owners.get(sessionID);
            owners.delete(sessionID);
            if (!owner || owner.cwd !== event.location.directory) continue;
            const bridgeURL = options.bridgeURL ?? process.env.OPENCODE_CHATGPT_WEB_BRIDGE_URL;
            if (!bridgeURL) {
              console.warn("[opencode-chatgpt-web] deleted session not revoked at bridge: OPENCODE_CHATGPT_WEB_BRIDGE_URL is missing");
              continue;
            }
            try {
              await (options.sendDeletion ?? sendOpenCodeSessionDeletion)(
                bridgeURL, signOpenCodeSessionDeletion(signingKey(), sessionID, owner),
              );
            } catch (error) {
              console.error(`[opencode-chatgpt-web] signed session deletion not delivered: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      })().catch(error => {
        if (!controller.signal.aborted) {
          console.warn(`[opencode-chatgpt-web] trusted lifecycle events unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      await ctx.session.hook("prompt", ({ sessionID, messageID }) => {
        prompts.set(sessionID, messageID);
      });
      await ctx.session.hook("context", async event => {
        if (event.model.providerID !== providerID) {
          return;
        }
        try {
          activatePrompt(event.sessionID);
          const session = await ctx.session.get({ sessionID: event.sessionID });
          if (session.id !== event.sessionID || !session.location?.directory || !session.projectID) {
            throw new Error("OpenCode could not resolve the originating trusted session location");
          }
          const model = `${event.model.providerID}/${event.model.id}`;
          const owner = {
            cwd: session.location.directory,
            projectID: session.projectID,
            agent: event.agent,
          };
          getIssuer().observeContext(event.sessionID, model, event.tools, owner);
          owners.set(event.sessionID, owner);
        } catch (error) {
          throw error;
        }
      });
      await ctx.session.hook("model.request", async event => {
        if (event.kind !== "primary" && event.kind !== "compaction") {
          return;
        }
        if (event.model.providerID !== providerID) return;
        try {
          // A continuation dispatched while compaction is still settling would be
          // signed with the pre-compaction epoch and rejected as dropped history.
          if (event.kind === "primary") await compactionGates.get(event.sessionID)?.promise;
          activatePrompt(event.sessionID);
          const model = `${event.model.providerID}/${event.model.id}`;
          event.headers[OPENCODE_TURN_HEADER] = event.kind === "compaction"
            ? getIssuer().signCompactionRequest(event.sessionID, model)
            : getIssuer().signPrimaryRequest(event.sessionID, model);
        } catch (error) {
          throw error;
        }
      }, { providerID });
    },
  };
}

export default createOpenCodeIdentityPlugin();
