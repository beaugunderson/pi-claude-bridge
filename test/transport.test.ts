import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Inbox } from "../src/inbox.ts";
import { deliver, sendUserMessage } from "../src/outbox.ts";
import { buildUserFrame, parseWrapped, procStartOf, type ControlFrame, type UserFrame } from "../src/protocol.ts";
import {
  listPeers,
  readPeerToken,
  removeKeyFile,
  removeRecord,
  updateRecord,
  writeKeyFile,
  writeRecord,
  type SessionRecord,
} from "../src/registry.ts";

let dir: string;
let inbox: Inbox | undefined;
const received: UserFrame[] = [];
const controls: ControlFrame[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pcb-"));
  received.length = 0;
  controls.length = 0;
});

afterEach(async () => {
  await inbox?.close();
  inbox = undefined;
  await rm(dir, { recursive: true, force: true });
});

const TOKEN = "0123456789abcdef0123456789abcdef";

async function startInbox(token?: string): Promise<string> {
  const socketPath = join(dir, "peer.sock");
  inbox = await Inbox.start({
    socketPath,
    token,
    onUser: (f) => received.push(f),
    onControl: (f) => controls.push(f),
    silenceMs: 500,
  });
  return socketPath;
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("inbox and outbox", () => {
  it("refuses a socket path the kernel cannot bind and names the fix", async () => {
    const socketPath = join(tmpdir(), "x".repeat(120), "1.sock");
    await expect(Inbox.start({ socketPath, token: TOKEN, onUser: () => {}, onControl: () => {} })).rejects.toThrow(
      /103.*PI_CLAUDE_BRIDGE_SOCKET_DIR/,
    );
  });

  it("delivers an authenticated user message and the receiver closes so the sender resolves", async () => {
    const socketPath = await startInbox(TOKEN);
    const msgId = await sendUserMessage({
      socketPath,
      token: TOKEN,
      body: "hello from the test",
      from: "uds:/tmp/cc-socks/1.sock",
      fromName: "tester-01",
    });
    await waitFor(() => received.length === 1);
    expect(received[0].msg_id).toBe(msgId);
    expect(received[0].from).toBe("uds:/tmp/cc-socks/1.sock");
    expect(parseWrapped(received[0].message.content)).toEqual({
      from: "uds:/tmp/cc-socks/1.sock",
      fromName: "tester-01",
      body: "hello from the test",
    });
  });

  it("drops frames from a connection that never authenticates", async () => {
    const socketPath = await startInbox(TOKEN);
    await deliver(socketPath, [buildUserFrame({ content: "sneaky", from: "uds:/x.sock" })]);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });

  it("drops frames after a wrong token", async () => {
    const socketPath = await startInbox(TOKEN);
    await deliver(socketPath, [buildUserFrame({ content: "sneaky", from: "uds:/x.sock" })], "f".repeat(32));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });

  it("accepts unauthenticated frames when no token is configured", async () => {
    const socketPath = await startInbox();
    await deliver(socketPath, [buildUserFrame({ content: "open", from: "uds:/x.sock" })]);
    await waitFor(() => received.length === 1);
  });

  it("passes control frames to onControl and ignores garbage lines", async () => {
    const socketPath = await startInbox(TOKEN);
    await new Promise<void>((resolve, reject) => {
      const conn = connect({ path: socketPath });
      conn.on("error", reject);
      conn.on("connect", () => {
        conn.write(`{"type":"auth","token":"${TOKEN}"}\n`);
        conn.write("this is not json\n");
        conn.write('{"type":"control","action":"peer_message_status","status":"delivered","orig_msg_id":"abc"}\n');
        conn.end();
      });
      conn.on("close", () => resolve());
    });
    await waitFor(() => controls.length === 1);
    expect(controls[0].action).toBe("peer_message_status");
    expect(received).toHaveLength(0);
  });

  it("handles a final line without a trailing newline", async () => {
    const socketPath = await startInbox();
    await new Promise<void>((resolve) => {
      const conn = connect({ path: socketPath });
      conn.on("connect", () => conn.end(JSON.stringify(buildUserFrame({ content: "tail", from: "uds:/x.sock" }))));
      conn.on("close", () => resolve());
    });
    await waitFor(() => received.length === 1);
  });

  it("creates the socket directory 0700 and the socket 0600", async () => {
    const socketPath = await startInbox();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it("fails to send to a socket nobody listens on", async () => {
    await expect(deliver(join(dir, "nobody.sock"), [buildUserFrame({ content: "x", from: "uds:/x.sock" })])).rejects.toThrow();
  });
});

describe("registry", () => {
  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    const now = Date.now();
    return {
      pid: process.pid,
      sessionId: "11111111-2222-4333-8444-555555555555",
      cwd: "/projects/thing",
      startedAt: now,
      version: "test",
      peerProtocol: 1,
      peerFeatures: [],
      kind: "interactive",
      entrypoint: "pi",
      pidDomain: "darwin",
      messagingSocketPath: "/tmp/cc-socks/test.sock",
      name: "pi-thing-ab",
      nameSource: "derived",
      nameSince: now,
      status: "idle",
      updatedAt: now,
      statusUpdatedAt: now,
      agent: "claude-bridge",
      ...overrides,
    };
  }

  it("writes a record Claude Code's parser fields are present in, updates it, and removes it", async () => {
    const sessions = join(dir, "sessions");
    await writeRecord(sessions, record({ procStart: await procStartOf(process.pid) }));
    const raw = JSON.parse(await readFile(join(sessions, `${process.pid}.json`), "utf8"));
    for (const key of ["pid", "sessionId", "cwd", "startedAt", "procStart", "kind", "status", "entrypoint", "pidDomain", "messagingSocketPath", "name"]) {
      expect(raw, key).toHaveProperty(key);
    }
    expect((await stat(sessions)).mode & 0o777).toBe(0o700);

    await updateRecord(sessions, process.pid, { status: "busy" });
    expect(JSON.parse(await readFile(join(sessions, `${process.pid}.json`), "utf8")).status).toBe("busy");

    await removeRecord(sessions, process.pid);
    expect(await readdir(sessions)).toEqual([]);
  });

  it("lists only live peers whose start stamp still matches, and excludes self on request", async () => {
    const sessions = join(dir, "sessions");
    const mine = await procStartOf(process.pid);
    await writeRecord(sessions, record({ procStart: mine }));
    await writeRecord(sessions, record({ pid: 2_000_000_000, name: "dead" }));
    await writeRecord(sessions, record({ pid: 1, name: "init-is-not-a-peer" }));
    // A live pid with a stale stamp is a recycled pid, not the session that wrote the record.
    await writeRecord(sessions, record({ pid: process.ppid, name: "recycled", procStart: "Mon Jan  1 00:00:00 2001" }));

    const peers = await listPeers(sessions);
    expect(peers.map((p) => p.name)).toEqual(["pi-thing-ab"]);
    expect(peers[0].socketPath).toBe("/tmp/cc-socks/test.sock");
    expect(await listPeers(sessions, { excludePid: process.pid })).toEqual([]);
  });

  it("publishes a 0600 key file Claude Code's lookup can find and reads the token back", async () => {
    const sessions = join(dir, "sessions");
    const socketPath = "/tmp/cc-socks/424242.sock";
    const path = await writeKeyFile(sessions, { pid: 424242, socketPath, token: TOKEN, procStart: "x", pidDomain: "darwin" });
    expect(path).toMatch(/\/424242\.[0-9a-f]{64}\.key$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ peerToken: TOKEN, procStart: "x", pidDomain: "darwin" });
    expect(await readPeerToken(sessions, 424242, socketPath)).toBe(TOKEN);
    expect(await readPeerToken(sessions, 424242, "/tmp/cc-socks/other.sock")).toBeUndefined();
    await removeKeyFile(sessions, 424242, socketPath);
    expect(await readPeerToken(sessions, 424242, socketPath)).toBeUndefined();
  });
});
