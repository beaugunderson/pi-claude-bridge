import { createServer, Socket, type Server } from "node:net";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { MAX_LINE_CHARS, parseFrame, type ControlFrame, type UserFrame } from "./protocol.ts";

/** `sun_path` limit on macOS (104 bytes including the terminator); node reports an overrun as EINVAL. */
export const MAX_SOCKET_PATH = 103;

export interface InboxOptions {
  socketPath: string;
  /** When set, every connection must open with a matching auth frame or its frames are dropped. */
  token?: string;
  onUser: (frame: UserFrame) => void;
  onControl?: (frame: ControlFrame) => void;
  log?: (message: string) => void;
  /** Connections that send no complete line within this window are closed. */
  silenceMs?: number;
}

/** A newline-delimited JSON server speaking Claude Code's peer messaging protocol. */
export class Inbox {
  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
  ) {}

  static async start(opts: InboxOptions): Promise<Inbox> {
    const log = opts.log ?? (() => {});
    if (Buffer.byteLength(opts.socketPath) > MAX_SOCKET_PATH) {
      throw new Error(
        `socket path is ${Buffer.byteLength(opts.socketPath)} bytes; the kernel allows ${MAX_SOCKET_PATH}. Set PI_CLAUDE_BRIDGE_SOCKET_DIR to a shorter directory: ${opts.socketPath}`,
      );
    }
    const dir = dirname(opts.socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await removeStaleSocket(opts.socketPath);

    const server = createServer({ allowHalfOpen: true }, (conn) => handleConnection(conn, opts, log));
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(opts.socketPath, () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    await chmod(opts.socketPath, 0o600);
    server.on("error", (error) => log(`server error: ${String(error)}`));
    return new Inbox(server, opts.socketPath);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise) => this.server.close(() => resolvePromise()));
    await unlink(this.socketPath).catch(() => {});
  }
}

/** Unlink a leftover socket file only when nothing is listening on it. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const info = await stat(socketPath);
    if (!info.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const live = await new Promise<boolean>((resolvePromise) => {
    const probe = new Socket();
    probe.setTimeout(250, () => {
      probe.destroy();
      resolvePromise(false);
    });
    probe.once("connect", () => {
      probe.destroy();
      resolvePromise(true);
    });
    probe.once("error", () => resolvePromise(false));
    probe.connect(socketPath);
  });
  if (live) throw new Error(`${socketPath} already has a live listener`);
  await unlink(socketPath);
}

function handleConnection(conn: Socket, opts: InboxOptions, log: (m: string) => void): void {
  let buffer = "";
  let authed = opts.token === undefined;
  let sawLine = false;
  conn.setEncoding("utf8");
  conn.setTimeout(opts.silenceMs ?? 10_000, () => {
    if (!sawLine) log("closing a silent connection");
    conn.destroy();
  });
  conn.on("error", (error) => log(`connection error: ${String(error)}`));

  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    sawLine = true;
    const frame = parseFrame(line);
    if (frame === undefined) {
      log("dropping an unparseable line");
      return;
    }
    if (frame.type === "auth") {
      authed = opts.token !== undefined && frame.token === opts.token;
      if (!authed) log("rejected a bad auth frame");
      return;
    }
    if (!authed) {
      log(`dropped a ${frame.type} frame from an unauthenticated connection`);
      conn.destroy();
      return;
    }
    if (frame.type === "user") opts.onUser(frame);
    else opts.onControl?.(frame);
  };

  conn.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_CHARS) {
      log("line exceeded the cap; dropping connection");
      conn.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });
  conn.on("end", () => {
    if (buffer.length > 0) handleLine(buffer);
    buffer = "";
    conn.end();
  });
}
