import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Wire protocol version Claude Code stamps on every user frame. */
export const MSG_VERSION = 1;

/** The XML-ish tag Claude Code wraps peer message bodies in. */
export const TAG = "cross-session-message";

/** Claude Code refuses lines longer than this; mirror the cap on both sides. */
export const MAX_LINE_CHARS = 1_000_000;

export interface AuthFrame {
  type: "auth";
  token: string;
}

export interface UserFrame {
  msgV: number;
  msg_id: string;
  type: "user";
  message: { role: "user"; content: string };
  priority: "now" | "next" | "later";
  from: string;
}

export interface ControlFrame {
  type: "control";
  action: string;
  [key: string]: unknown;
}

export type Frame = AuthFrame | UserFrame | ControlFrame;

export interface WrappedMessage {
  from?: string;
  fromName?: string;
  fromMode?: string;
  body: string;
}

function escapeAttr(value: string): string {
  return value.replace(/["<>\n\r]/g, "");
}

/**
 * Permission-mode classes a sender attests in `from-mode`. A receiver that bypasses prompts holds
 * messages whose sender attests nothing or a different class, pending the user's approval.
 */
export const PEER_MODES = ["bypass", "prompting"] as const;
export type PeerMode = (typeof PEER_MODES)[number];

export function isPeerMode(value: string | undefined): value is PeerMode {
  return (PEER_MODES as readonly string[]).includes(value ?? "");
}

/** Wrap a body the way Claude Code's SendMessage does, so the receiver renders it as a peer message. */
export function wrapMessage(body: string, opts: { from: string; fromName: string; fromMode?: PeerMode }): string {
  const mode = opts.fromMode === undefined ? "" : ` from-mode="${opts.fromMode}"`;
  return `<${TAG} from="${escapeAttr(opts.from)}" from-name="${escapeAttr(opts.fromName)}"${mode}>\n${body}\n</${TAG}>`;
}

/** Inverse of wrapMessage for frames arriving from Claude sessions. Returns the raw content as body when unwrapped. */
export function parseWrapped(content: string): WrappedMessage {
  const match = content.match(
    new RegExp(`^<${TAG}((?:\\s+[a-z-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${TAG}>$`),
  );
  if (!match) return { body: content };
  const attrs: Record<string, string> = {};
  for (const [, key, value] of match[1].matchAll(/\s+([a-z-]+)="([^"]*)"/g)) attrs[key] = value;
  return {
    ...(attrs.from !== undefined && { from: attrs.from }),
    ...(attrs["from-name"] !== undefined && { fromName: attrs["from-name"] }),
    ...(attrs["from-mode"] !== undefined && { fromMode: attrs["from-mode"] }),
    body: match[2],
  };
}

export function buildAuthFrame(token: string): AuthFrame {
  return { type: "auth", token };
}

export function buildUserFrame(opts: { content: string; from: string; msgId?: string }): UserFrame {
  return {
    msgV: MSG_VERSION,
    msg_id: opts.msgId ?? randomUUID(),
    type: "user",
    message: { role: "user", content: opts.content },
    priority: "next",
    from: opts.from,
  };
}

export function serializeFrame(frame: Frame): string {
  const line = JSON.stringify(frame);
  if (line.length + 1 > MAX_LINE_CHARS) {
    throw new Error(`frame is ${line.length} chars; the cross-session line cap is ${MAX_LINE_CHARS}`);
  }
  return `${line}\n`;
}

/** Parse one inbound line. Returns undefined for anything that is not a JSON object with a string `type`. */
export function parseFrame(line: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as Record<string, unknown>;
  if (typeof frame.type !== "string") return undefined;
  if (frame.type === "auth") return typeof frame.token === "string" ? { type: "auth", token: frame.token } : undefined;
  if (frame.type === "user") {
    const message = frame.message as Record<string, unknown> | undefined;
    if (typeof message?.content !== "string") return undefined;
    return frame as unknown as UserFrame;
  }
  if (frame.type === "control") return typeof frame.action === "string" ? (frame as ControlFrame) : undefined;
  return undefined;
}

/** `uds:` address for a socket path, the form Claude Code uses in `from` and accepts in SendMessage `to`. */
export function udsAddress(socketPath: string): string {
  return `uds:${socketPath}`;
}

export function parseUdsAddress(address: string): string | undefined {
  if (!address.startsWith("uds:")) return undefined;
  const path = address.slice(4);
  return path.startsWith("/") ? path : undefined;
}

/** Name of the auth key file Claude Code publishes and looks up: `<pid>.<sha256 of the resolved socket path>.key`. */
export function keyFileName(pid: number, socketPath: string): string {
  const digest = createHash("sha256").update(resolve(socketPath)).digest("hex");
  return `${pid}.${digest}.key`;
}

/** 16 random bytes as hex, the shape Claude Code's key-file schema accepts. */
export function newPeerToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Process start stamp exactly as Claude Code computes it, so its registry liveness check
 * (`ps -o lstart=` under LC_ALL=C TZ=UTC) matches a record this extension writes.
 */
export async function procStartOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeout: 1000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** `pi-<cwd basename>-<2 hex>`, parallel to Claude Code's derived `<basename>-<2 hex>` names. */
export function derivePeerName(cwd: string, seed: string = randomBytes(1).toString("hex")): string {
  const base = basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pi";
  return `pi-${base}-${seed.slice(0, 2)}`;
}
