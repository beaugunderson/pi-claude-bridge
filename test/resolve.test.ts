import { describe, expect, it } from "vitest";

import { modelLabel, peerMode, peerName, resolveTarget } from "../src/index.ts";
import type { Peer } from "../src/registry.ts";

describe("peerName", () => {
  it("prefers the env override verbatim, then pi's session name with a pi- prefix, then the derived name", () => {
    expect(peerName({ PI_PEER_NAME: "ops" }, "health", "pi-wiki-3f")).toEqual({ name: "ops", source: "user" });
    expect(peerName({}, "health", "pi-wiki-3f")).toEqual({ name: "pi-health", source: "user" });
    expect(peerName({}, undefined, "pi-wiki-3f")).toEqual({ name: "pi-wiki-3f", source: "derived" });
  });

  it("treats blank names as unset", () => {
    expect(peerName({ PI_PEER_NAME: "  " }, "  ", "pi-wiki-3f")).toEqual({ name: "pi-wiki-3f", source: "derived" });
  });
});

describe("modelLabel", () => {
  it("joins provider and id, and is undefined without a model", () => {
    expect(modelLabel({ provider: "example-provider", id: "example-model" })).toBe("example-provider/example-model");
    expect(modelLabel(undefined)).toBeUndefined();
  });
});

describe("peerMode", () => {
  it("defaults to unattested, honors explicit modes, and rejects invalid values", () => {
    expect(peerMode({})).toBeUndefined();
    expect(peerMode({ PI_PEER_MODE: "unattested" })).toBeUndefined();
    expect(peerMode({ PI_PEER_MODE: "bypass" })).toBe("bypass");
    expect(() => peerMode({ PI_PEER_MODE: "" })).toThrow(/PI_PEER_MODE/);
    expect(peerMode({ PI_PEER_MODE: "prompting" })).toBe("prompting");
    expect(() => peerMode({ PI_PEER_MODE: "yolo" })).toThrow(/PI_PEER_MODE/);
  });
});

const peers: Peer[] = [
  { pid: 1, name: "example-app-a7", socketPath: "/tmp/cc-socks/1.sock", cwd: "/projects/example-app", startedAt: 0, sessionId: "aaaaaa11" },
  { pid: 2, name: "example-app-86", socketPath: "/tmp/cc-socks/2.sock", cwd: "/projects/example-app", startedAt: 0, sessionId: "bbbbbb22" },
  { pid: 3, name: "wiki", socketPath: "/tmp/cc-socks/3.sock", cwd: "/projects/wiki", startedAt: 0, sessionId: "cccccc33" },
];

describe("resolveTarget", () => {
  it("resolves an exact name", () => {
    expect(resolveTarget("wiki", peers)).toEqual({ peer: peers[2], socketPath: "/tmp/cc-socks/3.sock" });
  });

  it("resolves a raw uds: address with or without a registry match", () => {
    expect(resolveTarget("uds:/tmp/cc-socks/2.sock", peers)).toEqual({ peer: peers[1], socketPath: "/tmp/cc-socks/2.sock" });
    expect(resolveTarget("uds:/tmp/pi-socks/x.sock", peers)).toEqual({ peer: undefined, socketPath: "/tmp/pi-socks/x.sock" });
  });

  it("asks for a ref when a prefix is ambiguous and honors the ref", () => {
    const ambiguous = resolveTarget("example-app", peers);
    expect("error" in ambiguous && ambiguous.error).toMatch(/several sessions/);
    expect(resolveTarget("example-app [bbbbbb]", peers)).toEqual({ peer: peers[1], socketPath: "/tmp/cc-socks/2.sock" });
    expect(resolveTarget("example-app-a7 [aaaaaa]", peers)).toEqual({ peer: peers[0], socketPath: "/tmp/cc-socks/1.sock" });
  });

  it("lists known peers when nothing matches", () => {
    const miss = resolveTarget("nope", peers);
    expect("error" in miss && miss.error).toMatch(/no live session named "nope"/);
    expect("error" in miss && miss.error).toMatch(/example-app-a7 \[aaaaaa\]/);
  });

  it("shows a pi peer's model in listings", () => {
    const withModel: Peer[] = [{ ...peers[2], agent: "claude-bridge", model: "example-provider/example-model" }];
    const miss = resolveTarget("nope", withModel);
    expect("error" in miss && miss.error).toMatch(/wiki \[cccccc\]  ·  pi  ·  unknown  ·  \/projects\/wiki  ·  example-provider\/example-model/);
  });
});
