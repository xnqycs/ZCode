import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRemoteCuaStubPlugin,
  loadRemoteCuaStub,
  resolveRemoteCuaStubEntries,
} from "../src/buildRemoteCuaStub.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_EXPORTS = {
  ".": { types: "./index.d.ts", import: "./index.js" },
  "./broker/server": { types: "./broker-server.d.ts", import: "./broker-server.js" },
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createFixture(
  options: { marker?: boolean; exports?: Record<string, { import?: string }> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-remote-cua-stub-"));
  tempRoots.push(root);
  const cuaRoot = join(root, "cua");
  await mkdir(join(cuaRoot, "placeholder"), { recursive: true });
  await writeFile(
    join(cuaRoot, "package.json"),
    JSON.stringify({ name: "@zcode/zcode-cua", exports: options.exports ?? DEFAULT_EXPORTS }),
  );
  await writeFile(
    join(cuaRoot, "placeholder", "index.js"),
    'export const stubEntry = "placeholder-entry";\n',
  );
  await writeFile(
    join(cuaRoot, "placeholder", "broker-server.js"),
    'export const stubBroker = "placeholder-broker";\n',
  );
  if (options.marker !== false) {
    await writeFile(join(cuaRoot, ".zcodepro-overlay.json"), "{}\n");
  }
  return { root, cuaRoot };
}

describe("remote CUA stub", () => {
  it("stays disabled for the plain placeholder build", async () => {
    const fixture = await createFixture({ marker: false });
    expect(loadRemoteCuaStub(fixture.cuaRoot)).toBeUndefined();
  });

  it("maps every exported CUA entry to the preserved placeholder implementation", async () => {
    const fixture = await createFixture();
    const stub = loadRemoteCuaStub(fixture.cuaRoot);

    expect(stub).toBeDefined();
    expect(Object.fromEntries(stub!.entries)).toEqual({
      "@zcode/zcode-cua": join(fixture.cuaRoot, "placeholder", "index.js"),
      "@zcode/zcode-cua/broker/server": join(fixture.cuaRoot, "placeholder", "broker-server.js"),
    });
  });

  it("rejects an export entry without an import target", async () => {
    const fixture = await createFixture({ exports: { "./broken": {} } });
    expect(() => resolveRemoteCuaStubEntries(fixture.cuaRoot)).toThrow(
      /has no import entry/,
    );
  });

  it("rejects an export entry whose placeholder file is missing", async () => {
    const fixture = await createFixture({
      exports: { "./missing": { import: "./missing.js" } },
    });
    expect(() => resolveRemoteCuaStubEntries(fixture.cuaRoot)).toThrow(
      /missing placeholder implementation/,
    );
  });

  it("covers every export of the checked-in package with a placeholder file", () => {
    const entries = resolveRemoteCuaStubEntries(join(repoRoot, "packages", "zcode-cua"));
    expect(entries.size).toBe(12);
    for (const [specifier, path] of entries) {
      expect(specifier.startsWith("@zcode/zcode-cua"), specifier).toBe(true);
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("bundles placeholder behavior instead of the vendor runtime", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, "entry.ts"),
      [
        'import { stubEntry } from "@zcode/zcode-cua";',
        'import { stubBroker } from "@zcode/zcode-cua/broker/server";',
        "export const result = `${stubEntry}:${stubBroker}`;",
      ].join("\n"),
    );
    const result = await build({
      absWorkingDir: fixture.root,
      bundle: true,
      entryPoints: ["entry.ts"],
      format: "cjs",
      platform: "node",
      plugins: [createRemoteCuaStubPlugin(loadRemoteCuaStub(fixture.cuaRoot)!)],
      write: false,
    });

    const source = result.outputFiles[0]?.text ?? "";
    expect(source).toContain("placeholder-entry");
    expect(source).toContain("placeholder-broker");
    expect(source).not.toContain("vendor");
  });

  it("fails the build for a CUA entry the stub does not cover", async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.root, "entry.ts"),
      'import "@zcode/zcode-cua/unknown";\n',
    );
    await expect(
      build({
        absWorkingDir: fixture.root,
        bundle: true,
        entryPoints: ["entry.ts"],
        format: "cjs",
        platform: "node",
        plugins: [createRemoteCuaStubPlugin(loadRemoteCuaStub(fixture.cuaRoot)!)],
        write: false,
      }),
    ).rejects.toThrow(/does not cover @zcode\/zcode-cua\/unknown/);
  });

  it("mentions the preserved placeholder files in the source contract", async () => {
    const source = await readFile(
      join(repoRoot, "packages", "zcode-cua", "index.js"),
      "utf8",
    );
    expect(source).toContain('./placeholder/index.js');
  });
});
