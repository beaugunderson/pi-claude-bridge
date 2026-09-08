import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildUserFrame,
  derivePeerName,
  keyFileName,
  newPeerToken,
  parseFrame,
  parseUdsAddress,
  parseWrapped,
  procStartOf,
  serializeFrame,
  udsAddress,
  wrapMessage,
} from "../src/protocol.ts";

// Synthetic fixture preserving the observed Claude Code 2.1.x wire shape.
const CLAUDE_FRAME =
  '{"msgV":1,"msg_id":"00000000-0000-4000-8000-000000000001","type":"user","message":{"role":"user","content":"<cross-session-message from=\\"uds:/tmp/cc-socks/12345.sock\\" from-name=\\"example-peer-01\\" from-mode=\\"bypass\\">\\nSynthetic fixture message.\\n</cross-session-message>"},"priority":"next","from":"uds:/tmp/cc-socks/12345.sock"}';

describe("frames", () => {
  it("parses a synthetic Claude Code user frame", () => {
    const frame = parseFrame(CLAUDE_FRAME);
    expect(frame?.type).toBe("user");
    if (frame?.type !== "user") throw new Error("unreachable");
    expect(frame.from).toBe("uds:/tmp/cc-socks/12345.sock");
    expect(parseWrapped(frame.message.content)).toEqual({
      from: "uds:/tmp/cc-socks/12345.sock",
      fromName: "example-peer-01",
      fromMode: "bypass",
      body: "Synthetic fixture message.",
    });
  });

  it("builds frames with the fields Claude Code emits", () => {
    const frame = buildUserFrame({ content: "hi", from: "uds:/tmp/cc-socks/1.sock", msgId: "abc" });
    expect(frame).toEqual({
      msgV: 1,
      msg_id: "abc",
      type: "user",
      message: { role: "user", content: "hi" },
      priority: "next",
      from: "uds:/tmp/cc-socks/1.sock",
    });
    expect(serializeFrame(frame).endsWith("\n")).toBe(true);
  });

  it("round-trips a wrapped body and strips attribute-breaking characters", () => {
    const wrapped = wrapMessage("line one\nline two", { from: "uds:/x.sock", fromName: 'evil"name<>' });
    expect(parseWrapped(wrapped)).toEqual({ from: "uds:/x.sock", fromName: "evilname", body: "line one\nline two" });
  });

  it("attests the permission-mode class when given, in the attribute Claude Code reads", () => {
    const wrapped = wrapMessage("body", { from: "uds:/x.sock", fromName: "pi-x-01", fromMode: "bypass" });
    expect(wrapped.startsWith('<cross-session-message from="uds:/x.sock" from-name="pi-x-01" from-mode="bypass">\n')).toBe(true);
    expect(parseWrapped(wrapped).fromMode).toBe("bypass");
    expect(parseWrapped(wrapMessage("body", { from: "uds:/x.sock", fromName: "n" })).fromMode).toBeUndefined();
  });

  it("returns the raw content as body when unwrapped", () => {
    expect(parseWrapped("plain text")).toEqual({ body: "plain text" });
  });

  it("rejects malformed lines", () => {
    expect(parseFrame("not json")).toBeUndefined();
    expect(parseFrame('{"type":"user"}')).toBeUndefined();
    expect(parseFrame('{"type":"auth"}')).toBeUndefined();
    expect(parseFrame('{"type":"control"}')).toBeUndefined();
    expect(parseFrame('{"notype":1}')).toBeUndefined();
    expect(parseFrame('{"type":"control","action":"peer_message_status"}')).toEqual({
      type: "control",
      action: "peer_message_status",
    });
  });
});

describe("addresses and keys", () => {
  it("formats and parses uds: addresses", () => {
    expect(udsAddress("/tmp/cc-socks/5.sock")).toBe("uds:/tmp/cc-socks/5.sock");
    expect(parseUdsAddress("uds:/tmp/cc-socks/5.sock")).toBe("/tmp/cc-socks/5.sock");
    expect(parseUdsAddress("example-peer-01")).toBeUndefined();
    expect(parseUdsAddress("uds:relative.sock")).toBeUndefined();
  });

  it("names the key file <pid>.<sha256 of the socket path>.key", () => {
    const digest = createHash("sha256").update("/tmp/cc-socks/23456.sock").digest("hex");
    expect(keyFileName(23456, "/tmp/cc-socks/23456.sock")).toBe(`23456.${digest}.key`);
    expect(keyFileName(23456, "/tmp/cc-socks/../cc-socks/23456.sock")).toBe(`23456.${digest}.key`);
  });

  it("mints 32-hex tokens", () => {
    expect(newPeerToken()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("process identity", () => {
  it("derives names like pi-<basename>-<2 hex>", () => {
    expect(derivePeerName("/projects/example-app", "a7ff")).toBe("pi-example-app-a7");
    expect(derivePeerName("/", "12")).toBe("pi-pi-12");
    expect(derivePeerName("/projects/my notes", "b8")).toBe("pi-my-notes-b8");
  });

  it("reads this process's start stamp in the ps lstart shape Claude Code compares against", async () => {
    const stamp = await procStartOf(process.pid);
    expect(stamp).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(await procStartOf(2_000_000_000)).toBeUndefined();
  });
});
