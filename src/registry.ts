import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { keyFileName, procStartOf } from "./protocol.ts";

/** A session record as Claude Code writes it to `<config dir>/sessions/<pid>.json`. */
export interface SessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart?: string;
  version: string;
  peerProtocol: number;
  peerFeatures: string[];
  kind: "interactive" | "bg" | "daemon" | "daemon-worker";
  entrypoint: string;
  pidDomain: string;
  messagingSocketPath: string;
  name: string;
  nameSource: "derived" | "user";
  nameSince: number;
  status: "busy" | "shell" | "idle" | "waiting";
  updatedAt: number;
  statusUpdatedAt: number;
  /** Marks records this extension wrote; Claude Code ignores unknown fields. */
  agent?: string;
  /** `provider/id` of the model a pi session is running; absent on Claude Code records. */
  model?: string;
}

export interface Peer {
  pid: number;
  name: string;
  socketPath: string;
  status?: string;
  kind?: string;
  cwd: string;
  startedAt: number;
  sessionId?: string;
  agent?: string;
  model?: string;
}

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Sessions only see peers in the same dir. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".claude");
}

export function sessionsDir(config: string): string {
  return join(config, "sessions");
}

function recordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(16)}`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
}

export async function ensureSessionsDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function writeRecord(dir: string, record: SessionRecord): Promise<void> {
  await ensureSessionsDir(dir);
  await writeAtomic(recordPath(dir, record.pid), JSON.stringify(record), 0o644);
}

export async function readRecord(dir: string, pid: number): Promise<Partial<SessionRecord> | undefined> {
  try {
    return JSON.parse(await readFile(recordPath(dir, pid), "utf8")) as Partial<SessionRecord>;
  } catch {
    return undefined;
  }
}

export async function updateRecord(dir: string, pid: number, patch: Partial<SessionRecord>): Promise<void> {
  const current = await readRecord(dir, pid);
  if (current === undefined) throw new Error(`no session record for pid ${pid} in ${dir}`);
  await writeAtomic(recordPath(dir, pid), JSON.stringify({ ...current, ...patch }), 0o644);
}

export async function removeRecord(dir: string, pid: number): Promise<void> {
  await unlink(recordPath(dir, pid)).catch(() => {});
}

export async function writeKeyFile(
  dir: string,
  opts: { pid: number; socketPath: string; token: string; procStart?: string; pidDomain: string },
): Promise<string> {
  await ensureSessionsDir(dir);
  const path = join(dir, keyFileName(opts.pid, opts.socketPath));
  await unlink(path).catch(() => {});
  await writeAtomic(
    path,
    JSON.stringify({ peerToken: opts.token, procStart: opts.procStart, pidDomain: opts.pidDomain }),
    0o600,
  );
  return path;
}

export async function removeKeyFile(dir: string, pid: number, socketPath: string): Promise<void> {
  await unlink(join(dir, keyFileName(pid, socketPath))).catch(() => {});
}

/** The peer token a live session published for its socket, or undefined when it has none. */
export async function readPeerToken(dir: string, pid: number, socketPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, keyFileName(pid, socketPath)), "utf8")) as {
      peerToken?: unknown;
    };
    return typeof parsed.peerToken === "string" && /^[0-9a-f]{32}$/.test(parsed.peerToken)
      ? parsed.peerToken
      : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Live peers registered in `dir`: the process exists and, when the record carries a start stamp, it still matches. */
export async function listPeers(dir: string, opts: { excludePid?: number } = {}): Promise<Peer[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const peers: Peer[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    if (pid === opts.excludePid || !isAlive(pid)) continue;
    const record = await readRecord(dir, pid);
    if (record === undefined || typeof record.messagingSocketPath !== "string") continue;
    if (typeof record.procStart === "string" && (await procStartOf(pid)) !== record.procStart) continue;
    peers.push({
      pid,
      name: typeof record.name === "string" ? record.name : `pid-${pid}`,
      socketPath: record.messagingSocketPath,
      status: record.status,
      kind: record.kind,
      cwd: record.cwd ?? "?",
      startedAt: record.startedAt ?? 0,
      sessionId: record.sessionId,
      agent: record.agent,
      model: typeof record.model === "string" ? record.model : undefined,
    });
  }
  return peers;
}
