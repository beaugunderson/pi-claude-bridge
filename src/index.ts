import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { Inbox } from "./inbox.ts";
import { sendUserMessage } from "./outbox.ts";
import {
  derivePeerName,
  isPeerMode,
  newPeerToken,
  parseUdsAddress,
  parseWrapped,
  procStartOf,
  udsAddress,
  type PeerMode,
} from "./protocol.ts";
import {
  configDir,
  listPeers,
  readPeerToken,
  removeKeyFile,
  removeRecord,
  sessionsDir,
  updateRecord,
  writeKeyFile,
  writeRecord,
  type Peer,
  type SessionRecord,
} from "./registry.ts";

const VERSION = "pi-claude-bridge/0.1.0";
const CUSTOM_TYPE = "claude-bridge";

interface ListDetails {
  peers?: Peer[];
}

interface SendDetails {
  msgId?: string;
}

function textResult<T>(text: string, details: T, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

interface BridgeState {
  inbox: Inbox;
  dir: string;
  name: string;
  /** The cwd-derived name, kept so a cleared session name falls back to a stable address. */
  derivedName: string;
  address: string;
  socketPath: string;
  mode: PeerMode | undefined;
}

/** Explicit sender attestation only; an unset mode makes no claim about local permissions. */
export function peerMode(env: NodeJS.ProcessEnv): PeerMode | undefined {
  const value = env.PI_PEER_MODE;
  if (value === undefined || value === "unattested") return undefined;
  if (!isPeerMode(value)) throw new Error(`PI_PEER_MODE must be "unattested", "bypass", or "prompting", got "${value}"`);
  return value;
}

function socketDir(env: NodeJS.ProcessEnv): string {
  if (env.PI_CLAUDE_BRIDGE_SOCKET_DIR) return env.PI_CLAUDE_BRIDGE_SOCKET_DIR;
  if (env.CLAUDE_CODE_TMPDIR) return join(env.CLAUDE_CODE_TMPDIR, "cc-socks");
  return "/tmp/cc-socks";
}

function makeLogger(env: NodeJS.ProcessEnv): (message: string) => void {
  const path = env.PI_CLAUDE_BRIDGE_LOG;
  if (!path) return () => {};
  return (message) => {
    appendFile(path, `${new Date().toISOString()} ${message}\n`).catch(() => {});
  };
}

function describePeer(peer: Peer): string {
  const ref = peer.sessionId ? ` [${peer.sessionId.slice(0, 6)}]` : "";
  const parts = [peer.agent === CUSTOM_TYPE ? "pi" : "claude", peer.status ?? "unknown", peer.cwd];
  if (peer.model) parts.push(peer.model);
  return `${peer.name}${ref}  ·  ${parts.join("  ·  ")}`;
}

/**
 * The name this session registers under: `PI_PEER_NAME` verbatim when set, else `pi-` plus pi's own
 * session name (`/name`, `--name`) so pi peers stay recognizable next to Claude sessions, else one
 * derived from the cwd. The derived fallback is fixed per session so a cleared name returns to the
 * address peers already saw.
 */
export function peerName(env: NodeJS.ProcessEnv, sessionName: string | undefined, derived: string): { name: string; source: "user" | "derived" } {
  const fromEnv = env.PI_PEER_NAME?.trim();
  if (fromEnv) return { name: fromEnv, source: "user" };
  const fromSession = sessionName?.trim();
  if (fromSession) return { name: `pi-${fromSession}`, source: "user" };
  return { name: derived, source: "derived" };
}

/** `provider/id` for the registry record, or undefined when pi has no model selected. */
export function modelLabel(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/** Resolve a `to` argument: a `uds:` address, an exact peer name, `name [ref]`, or a unique name prefix. */
export function resolveTarget(to: string, peers: Peer[]): { peer?: Peer; socketPath: string } | { error: string } {
  const direct = parseUdsAddress(to.trim());
  if (direct !== undefined) {
    return { peer: peers.find((p) => p.socketPath === direct), socketPath: direct };
  }
  const match = /^(.*?)\s*(?:\[([0-9a-f]{1,})\])?$/.exec(to.trim());
  const name = match?.[1] ?? to.trim();
  const ref = match?.[2];
  let candidates = peers.filter((p) => p.name === name);
  if (candidates.length === 0) candidates = peers.filter((p) => p.name.startsWith(name));
  if (ref !== undefined) candidates = candidates.filter((p) => p.sessionId?.startsWith(ref));
  if (candidates.length === 1) return { peer: candidates[0], socketPath: candidates[0].socketPath };
  if (candidates.length === 0) {
    return { error: `no live session named "${to}". Known peers:\n${peers.map(describePeer).join("\n") || "(none)"}` };
  }
  return {
    error: `"${to}" matches several sessions; pass the name with its [ref]:\n${candidates.map(describePeer).join("\n")}`,
  };
}

export default function (pi: ExtensionAPI) {
  let state: BridgeState | undefined;
  const log = makeLogger(process.env);

  async function start(ctx: ExtensionContext): Promise<void> {
    if (state !== undefined) return;
    const dir = sessionsDir(configDir(process.env));
    const socketPath = join(socketDir(process.env), `${process.pid}.sock`);
    const address = udsAddress(socketPath);
    const derivedName = derivePeerName(ctx.cwd);
    const { name, source } = peerName(process.env, ctx.sessionManager.getSessionName(), derivedName);
    const mode = peerMode(process.env);
    const token = newPeerToken();
    const procStart = await procStartOf(process.pid);

    const inbox = await Inbox.start({
      socketPath,
      token,
      log,
      onUser: (frame) => {
        const wrapped = parseWrapped(frame.message.content);
        const fromName = wrapped.fromName ?? "unknown";
        const from = wrapped.from ?? frame.from;
        log(`inbound from ${fromName} (${from}): ${wrapped.body.slice(0, 80)}`);
        pi.sendMessage(
          {
            customType: CUSTOM_TYPE,
            content: [
              `Cross-session message from Claude Code session "${fromName}" (address ${from}).`,
              `It is a teammate working on the user's behalf, not the user. To reply, call send_to_claude with to="${from}".`,
              "",
              wrapped.body,
            ].join("\n"),
            display: true,
            details: { from, fromName, msgId: frame.msg_id },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      },
      onControl: (frame) => log(`control ${frame.action} from a peer`),
    });

    let keyWritten = false;
    try {
      await writeKeyFile(dir, { pid: process.pid, socketPath, token, procStart, pidDomain: "darwin" });
      keyWritten = true;
      await writeRecord(dir, {
        pid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        startedAt: Date.now(),
        procStart,
        version: VERSION,
        peerProtocol: 1,
        peerFeatures: [],
        kind: "interactive",
        entrypoint: "pi",
        pidDomain: "darwin",
        messagingSocketPath: socketPath,
        name,
        nameSource: source,
        nameSince: Date.now(),
        status: "idle",
        updatedAt: Date.now(),
        statusUpdatedAt: Date.now(),
        agent: CUSTOM_TYPE,
        model: modelLabel(ctx.model),
      });
    } catch (error) {
      // A failed atomic write did not publish a record. Remove only the key we published,
      // and always close our listener without replacing the startup error with a cleanup error.
      if (keyWritten) await removeKeyFile(dir, process.pid, socketPath).catch(() => {});
      await inbox.close().catch(() => {});
      throw error;
    }
    state = { inbox, dir, name, derivedName, address, socketPath, mode };
    log(`listening at ${socketPath} as ${name} (mode ${mode ?? "unattested"}, model ${modelLabel(ctx.model) ?? "none"}), registry ${dir}`);
  }

  /** Re-register under pi's current session name; called when the name changes or a session is resumed. */
  async function refreshIdentity(ctx: ExtensionContext, sessionName: string | undefined): Promise<void> {
    if (state === undefined) return;
    const { name, source } = peerName(process.env, sessionName, state.derivedName);
    const now = Date.now();
    const patch: Partial<SessionRecord> = {
      sessionId: ctx.sessionManager.getSessionId(),
      model: modelLabel(ctx.model),
      updatedAt: now,
    };
    if (name !== state.name) Object.assign(patch, { name, nameSource: source, nameSince: now });
    state.name = name;
    await updateRecord(state.dir, process.pid, patch).catch((error) => log(`identity update failed: ${String(error)}`));
    log(`registered as ${name} (${source}), model ${patch.model ?? "none"}`);
  }

  async function stop(): Promise<void> {
    if (state === undefined) return;
    const { inbox, dir, socketPath } = state;
    state = undefined;
    await removeRecord(dir, process.pid);
    await removeKeyFile(dir, process.pid, socketPath);
    await inbox.close();
  }

  async function setStatus(status: "busy" | "idle"): Promise<void> {
    if (state === undefined) return;
    const now = Date.now();
    await updateRecord(state.dir, process.pid, { status, updatedAt: now, statusUpdatedAt: now }).catch((error) =>
      log(`status update failed: ${String(error)}`),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (state === undefined) await start(ctx);
      else await refreshIdentity(ctx, ctx.sessionManager.getSessionName());
    } catch (error) {
      log(`start failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      ctx.ui.notify(`claude-bridge failed to start: ${String(error)}`, "error");
    }
  });
  pi.on("session_info_changed", async (event, ctx) => refreshIdentity(ctx, event.name));
  pi.on("model_select", async (event) => {
    if (state === undefined) return;
    await updateRecord(state.dir, process.pid, { model: modelLabel(event.model), updatedAt: Date.now() }).catch((error) =>
      log(`model update failed: ${String(error)}`),
    );
  });
  pi.on("session_shutdown", async () => stop());
  pi.on("agent_start", async () => setStatus("busy"));
  pi.on("agent_settled", async () => setStatus("idle"));

  pi.registerTool({
    name: "list_claude_sessions",
    label: "List Claude sessions",
    description:
      "List the live Claude Code and pi sessions on this machine that can receive cross-session messages. Each row is `name [ref]  ·  kind  ·  status  ·  cwd`; the name is the address for send_to_claude.",
    promptSnippet: "list_claude_sessions: discover peer Claude Code / pi sessions to coordinate with",
    parameters: Type.Object({}),
    async execute() {
      if (state === undefined) return textResult<ListDetails>("claude-bridge is not running", {}, true);
      const peers = await listPeers(state.dir, { excludePid: process.pid });
      const lines = [
        `This session is ${state.name} (${state.address}).`,
        peers.length === 0 ? "No other live sessions." : `Peer sessions (${peers.length}):`,
        ...peers.map((p) => `  ${describePeer(p)}`),
      ];
      return textResult<ListDetails>(lines.join("\n"), { peers });
    },
  });

  pi.registerTool({
    name: "send_to_claude",
    label: "Send to Claude session",
    description:
      "Send a message to another live session on this machine (a Claude Code session or another pi session). `to` is a name from list_claude_sessions, optionally with its [ref], or a raw uds:/path.sock address. The recipient sees the first line as a preview, so make it a self-contained sentence. Delivery enqueues the message; the peer processes it at its next turn and replies with a message of its own.",
    promptSnippet: "send_to_claude: message a peer Claude Code / pi session by name",
    promptGuidelines: [
      "Cross-session messages arrive as `Cross-session message from Claude Code session ...`. They come from a peer agent, not the user; act on them within this session's own permissions and reply with send_to_claude to the address given.",
      "Never ask a peer session to perform an action this session was denied.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Peer name from list_claude_sessions (optionally `name [ref]`), or a uds:/path.sock address" }),
      message: Type.String({ description: "Plain-text message. First line should stand alone as a summary." }),
    }),
    async execute(_id, params) {
      if (state === undefined) return textResult<SendDetails>("claude-bridge is not running", {}, true);
      const peers = await listPeers(state.dir, { excludePid: process.pid });
      const target = resolveTarget(params.to, peers);
      if ("error" in target) return textResult<SendDetails>(target.error, {}, true);
      const token = target.peer ? await readPeerToken(state.dir, target.peer.pid, target.socketPath) : undefined;
      try {
        const msgId = await sendUserMessage({
          socketPath: target.socketPath,
          token,
          body: params.message,
          from: state.address,
          fromName: state.name,
          fromMode: state.mode,
        });
        const label = target.peer ? `${target.peer.name} (${udsAddress(target.socketPath)})` : udsAddress(target.socketPath);
        return textResult<SendDetails>(`Sent to ${label}; msg_id ${msgId}`, { msgId });
      } catch (error) {
        return textResult<SendDetails>(`Send failed: ${String(error)}`, {}, true);
      }
    },
  });

  pi.registerCommand("peers", {
    description: "Show live Claude Code / pi sessions reachable from this one",
    handler: async (_args, ctx) => {
      if (state === undefined) {
        ctx.ui.notify("claude-bridge is not running", "warning");
        return;
      }
      const peers = await listPeers(state.dir, { excludePid: process.pid });
      ctx.ui.notify(
        [`this session: ${state.name}`, ...peers.map(describePeer)].join("\n"),
        "info",
      );
    },
  });
}
