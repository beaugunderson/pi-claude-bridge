import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("loads a source-only package using host-supplied TypeBox without starting a session", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.peerDependencies.typebox).toBe("*");
  expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  const hostRequire = createRequire(await realpath(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)));
  const { createJiti } = await import(hostRequire.resolve("jiti"));
  const dir = await mkdtemp(join(tmpdir(), "pcb-package-"));
  try {
    await cp(new URL("../src", import.meta.url), join(dir, "src"), { recursive: true });
    // Mirrors Pi's Node loader alias: the package has no local node_modules at all.
    const jiti = createJiti(import.meta.url, { fsCache: false, alias: { typebox: hostRequire.resolve("typebox") } });
    const factory = await jiti.import(join(dir, manifest.pi.extensions[0]), { default: true });
    const names: string[] = [];
    factory({
      on() {},
      registerCommand() {},
      registerTool(tool: { name: string; parameters: { type: string } }) {
        expect(tool.parameters.type).toBe("object");
        names.push(tool.name);
      },
    });
    expect(names).toEqual(["list_claude_sessions", "send_to_claude"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
