import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge from "../src/index.ts";
import { Inbox, type InboxOptions } from "../src/inbox.ts";
import { sendUserMessage } from "../src/outbox.ts";
import { buildUserFrame, wrapMessage } from "../src/protocol.ts";
import { removeKeyFile, removeRecord, writeKeyFile, writeRecord } from "../src/registry.ts";

vi.mock("../src/inbox.ts", () => ({ Inbox: { start: vi.fn() } }));
vi.mock("../src/outbox.ts", () => ({ sendUserMessage: vi.fn(async () => "fixture-message-id") }));
vi.mock("../src/registry.ts", () => ({
  configDir: () => "/fixture/config",
  sessionsDir: () => "/fixture/config/sessions",
  listPeers: async () => [],
  readPeerToken: vi.fn(),
  removeKeyFile: vi.fn(async () => {}),
  removeRecord: vi.fn(),
  updateRecord: vi.fn(),
  writeKeyFile: vi.fn(),
  writeRecord: vi.fn(),
}));
vi.mock("../src/protocol.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/protocol.ts")>(),
  procStartOf: async () => "Mon Jan  1 00:00:00 2001",
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("extension startup rollback", () => {
  function fixture() {
    vi.stubEnv("PI_PEER_MODE", "unattested");
    vi.stubEnv("PI_CLAUDE_BRIDGE_LOG", "");
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void>>();
    const tools = new Map<string, any>();
    const notify = vi.fn();
    bridge({
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: "/fixture/project",
      sessionManager: { getSessionName: () => "demo", getSessionId: () => "fixture-session" },
      ui: { notify },
    } as unknown as ExtensionContext;
    return {
      notify,
      start: () => handlers.get("session_start")!({}, ctx),
      stop: () => handlers.get("session_shutdown")!({}, ctx),
      send: () => tools.get("send_to_claude").execute("fixture-call", { to: "uds:/fixture/target.sock", message: "fixture" }),
    };
  }

  it.each(["key", "record"] as const)("closes the real listener after a %s write failure and allows retry", async (failure) => {
    const dir = await mkdtemp(join(tmpdir(), "pcb-start-"));
    vi.stubEnv("PI_CLAUDE_BRIDGE_SOCKET_DIR", dir);
    const socketPath = join(dir, `${process.pid}.sock`);
    const { Inbox: RealInbox } = await vi.importActual<typeof import("../src/inbox.ts")>("../src/inbox.ts");
    const listeners: Inbox[] = [];
    vi.mocked(Inbox.start).mockImplementation(async (opts) => {
      const inbox = await RealInbox.start(opts);
      vi.spyOn(inbox, "close");
      listeners.push(inbox);
      return inbox;
    });
    const original = new Error(`synthetic ${failure} write failure`);
    vi.mocked(failure === "key" ? writeKeyFile : writeRecord).mockRejectedValueOnce(original);
    const app = fixture();
    try {
      await app.start();
      expect(app.notify).toHaveBeenCalledWith(`claude-bridge failed to start: ${String(original)}`, "error");
      expect(listeners).toHaveLength(1);
      expect(listeners[0].close).toHaveBeenCalledOnce();
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(removeRecord).not.toHaveBeenCalled();
      if (failure === "key") {
        expect(writeRecord).not.toHaveBeenCalled();
        expect(removeKeyFile).not.toHaveBeenCalled();
      } else {
        expect(removeKeyFile).toHaveBeenCalledExactlyOnceWith("/fixture/config/sessions", process.pid, socketPath);
      }
      expect(await app.send()).toMatchObject({ isError: true });
      expect(sendUserMessage).not.toHaveBeenCalled();
      await app.stop();
      expect(listeners[0].close).toHaveBeenCalledOnce();

      await app.start();
      expect(app.notify).toHaveBeenCalledTimes(1);
      expect(Inbox.start).toHaveBeenCalledTimes(2);
      expect((await stat(socketPath)).isSocket()).toBe(true);
      expect(await app.send()).toMatchObject({ isError: false });
      await app.stop();
      expect(listeners[1].close).toHaveBeenCalledOnce();
      expect(removeRecord).toHaveBeenCalledExactlyOnceWith("/fixture/config/sessions", process.pid);
      await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const inbox of listeners) await inbox.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["key", "record"] as const)("preserves the %s write error even when rollback fails", async (failure) => {
    const close = vi.fn().mockRejectedValueOnce(new Error("synthetic close failure"));
    vi.mocked(Inbox.start).mockResolvedValue({ close } as unknown as Inbox);
    const original = new Error(`synthetic ${failure} write failure`);
    vi.mocked(failure === "key" ? writeKeyFile : writeRecord).mockRejectedValueOnce(original);
    if (failure === "record") vi.mocked(removeKeyFile).mockRejectedValueOnce(new Error("synthetic key cleanup failure"));
    const app = fixture();
    await app.start();
    expect(close).toHaveBeenCalledOnce();
    expect(app.notify).toHaveBeenCalledExactlyOnceWith(`claude-bridge failed to start: ${String(original)}`, "error");
    expect(removeRecord).not.toHaveBeenCalled();
    await app.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not clean up resources when it never acquired an inbox", async () => {
    vi.mocked(Inbox.start).mockRejectedValueOnce(new Error("synthetic existing listener"));
    const app = fixture();
    await app.start();
    await app.stop();
    expect(writeKeyFile).not.toHaveBeenCalled();
    expect(writeRecord).not.toHaveBeenCalled();
    expect(removeKeyFile).not.toHaveBeenCalled();
    expect(removeRecord).not.toHaveBeenCalled();
  });
});

describe("extension boundary", () => {
  it.each([undefined, "unattested", "prompting", "bypass"])("preserves auth and peer authority with mode %s", async (mode) => {
    vi.stubEnv("PI_PEER_MODE", mode);
    vi.stubEnv("PI_CLAUDE_BRIDGE_LOG", "");
    vi.stubEnv("PI_PEER_NAME", "fixture-sender");
    vi.stubEnv("PI_CLAUDE_BRIDGE_SOCKET_DIR", "/fixture/sockets");
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void>>();
    const registeredTools = new Map<string, any>();
    const close = vi.fn(async () => {});
    vi.mocked(Inbox.start).mockResolvedValue({ close } as unknown as Inbox);
    const sendMessage = vi.fn();
    const sendUserMessageAsUser = vi.fn();
    const api = {
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerTool: (tool: any) => registeredTools.set(tool.name, tool),
      registerCommand: vi.fn(),
      sendMessage,
      sendUserMessage: sendUserMessageAsUser,
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/fixture/project",
      sessionManager: { getSessionName: () => "demo", getSessionId: () => "fixture-session" },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    bridge(api);
    expect(Inbox.start).not.toHaveBeenCalled();
    await handlers.get("session_start")!({}, ctx);
    const inboxOptions: InboxOptions = vi.mocked(Inbox.start).mock.calls[0][0];
    expect(inboxOptions.token).toMatch(/^[0-9a-f]{32}$/);
    inboxOptions.onUser(buildUserFrame({
      from: "uds:/fixture/peer.sock",
      content: wrapMessage("Synthetic peer request", { from: "uds:/fixture/peer.sock", fromName: "fixture-peer" }),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      customType: "claude-bridge",
      content: expect.stringContaining("not the user"),
    }), { triggerTurn: true, deliverAs: "followUp" });
    expect(sendUserMessageAsUser).not.toHaveBeenCalled();
    const sender = registeredTools.get("send_to_claude");
    expect(sender.promptGuidelines.join(" ")).toContain("Never ask a peer session to perform an action this session was denied.");
    await sender.execute("fixture-call", { to: "uds:/fixture/target.sock", message: "Synthetic outbound message" });
    const options = vi.mocked(sendUserMessage).mock.calls[0][0];
    const expectedMode = mode === "bypass" || mode === "prompting" ? mode : undefined;
    expect(options.fromMode).toBe(expectedMode);
    const body = wrapMessage(options.body, options);
    if (expectedMode) expect(body).toContain(`from-mode="${expectedMode}"`);
    else expect(body).not.toContain("from-mode=");
    await handlers.get("session_shutdown")!({}, ctx);
    expect(close).toHaveBeenCalledOnce();
  });
});
