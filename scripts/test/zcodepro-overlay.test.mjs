import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  applyOverlay,
  checkOverlay,
  parseOverlayArgs,
  revertOverlay,
} from "../zcodepro/apply-zcodepro.mjs";

const exec = promisify(execFile);
const overlayScript = resolve(import.meta.dirname, "../zcodepro/apply-zcodepro.mjs");
const WINDOWS_X64_ENV = { ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "x64" };
const DOC_PLUGINS = ["documents", "pdf", "presentations", "spreadsheets"];
const HELPER_ENTRY_LF = [
  'import { helper } from "./helper.mjs";',
  "export const entry = helper;",
  "",
].join("\n");
const HELPER_ENTRY_CRLF = HELPER_ENTRY_LF.replaceAll("\n", "\r\n");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function x64PeBuffer() {
  const bytes = Buffer.alloc(0x100);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, value);
}

async function initRepo(root) {
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
    { cwd: root },
  );
}

function producerPackage(overrides = {}) {
  return {
    name: "@zcode/zcode-cua",
    version: "0.6.5",
    private: true,
    type: "module",
    exports: {
      ".": { types: "./index.d.ts", import: "./index.js" },
      "./broker/server": { types: "./broker-server.d.ts", import: "./broker-server.js" },
    },
    ...overrides,
  };
}

async function createZcodeProFixture(root, options = {}) {
  const version = options.version ?? "0.6.5";
  const helperVersion = options.helperVersion ?? version;
  const entryBytes = options.entryBytes ?? Buffer.from(HELPER_ENTRY_CRLF);
  const addonBytes = options.addonBytes ?? x64PeBuffer();
  const producerRoot = join(root, "runtimes", "zcode-cua");
  const helperRoot = join(root, "runtimes", "cua-helper");

  await writeJson(join(producerRoot, "package.json"), producerPackage({ version }));
  await writeText(join(producerRoot, "index.js"), "export const runtime = 'real';\n");
  await writeText(join(producerRoot, "index.d.ts"), "export declare const runtime: string;\n");
  await writeText(join(producerRoot, "broker-server.js"), "export const broker = true;\n");
  await writeText(
    join(producerRoot, "broker-server.d.ts"),
    "export declare const broker: boolean;\n",
  );
  await writeText(join(producerRoot, "vendor", "dist-index.js"), "export const vendor = 1;\r\n");

  await writeJson(join(helperRoot, "package.json"), {
    name: "@zcode/zcode-cua-helper-runtime",
    version: helperVersion,
    type: "module",
    private: true,
    main: "dist/windows-helper.js",
  });
  await writeJson(join(helperRoot, "runtime-manifest.json"), {
    schemaVersion: 1,
    packageName: "@zcode/zcode-cua",
    packageVersion: version,
    platform: "win32",
    arch: "x64",
    electronVersion: "41.0.3",
    entry: "dist/windows-helper.js",
    addon: "build/Release/ax_native.node",
    sha256: {
      entry: options.manifestEntryHash ?? sha256(Buffer.from(HELPER_ENTRY_LF)),
      addon: options.manifestAddonHash ?? sha256(addonBytes),
    },
  });
  await mkdir(join(helperRoot, "dist"), { recursive: true });
  await writeFile(join(helperRoot, "dist", "windows-helper.js"), entryBytes);
  await mkdir(join(helperRoot, "build", "Release"), { recursive: true });
  await writeFile(join(helperRoot, "build", "Release", "ax_native.node"), addonBytes);
  await writeJson(join(helperRoot, "node_modules", "sharp", "package.json"), {
    name: "sharp",
    version: options.sharpVersion ?? "0.34.5",
  });
  await writeJson(join(helperRoot, "node_modules", "express", "package.json"), {
    name: "express",
    version: options.expressVersion ?? "5.2.1",
  });
  for (const name of DOC_PLUGINS) {
    await writeJson(join(root, "plugins", `${name}-plugin`, "package.json"), {
      name: `@zcode/${name}-plugin`,
      version: options.docPluginVersion ?? "0.2.1",
    });
  }
  const git = options.git ?? true;
  if (git) await initRepo(root);
  return { root, producerRoot, helperRoot, entryBytes, addonBytes };
}

async function createRepoFixture(root, options = {}) {
  await writeText(
    join(root, ".gitignore"),
    [
      "node_modules/",
      "dist/",
      "build/",
      "vendor/",
      "bundled-agents/",
      "bundled-tools/",
      "packages/desktop/out/",
      "",
    ].join("\n"),
  );
  await writeJson(join(root, "packages", "desktop", "package.json"), {
    name: "@zcode/desktop",
    devDependencies: { electron: "41.0.3" },
  });
  await writeText(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const cuaRoot = join(root, "packages", "zcode-cua");
  await writeJson(
    join(cuaRoot, "package.json"),
    producerPackage({
      description: "placeholder",
      scripts: { build: "tsc --noEmit -p tsconfig.json" },
      zcodeCuaPlaceholder: true,
    }),
  );
  await writeJson(join(cuaRoot, "tsconfig.json"), {
    compilerOptions: { noEmit: true },
    include: ["*.d.ts"],
  });
  await writeText(
    join(cuaRoot, "vitest.config.ts"),
    'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({});\n',
  );
  await writeText(join(cuaRoot, "index.js"), "export const runtime = 'placeholder';\n");
  await writeText(join(cuaRoot, "index.d.ts"), "export declare const runtime: string;\n");
  await writeText(join(cuaRoot, "broker-server.js"), "export const broker = false;\n");
  await writeText(
    join(cuaRoot, "broker-server.d.ts"),
    [
      "export declare const broker: boolean;",
      "",
      "export declare function resolveHelperAppName(env?: NodeJS.ProcessEnv): string;",
      "export declare function resolveCuaHelperInstallRoot(env: NodeJS.ProcessEnv): string | null;",
      "export declare function standaloneHelperCandidatePaths(env?: NodeJS.ProcessEnv): string[];",
      "",
    ].join("\n"),
  );
  await writeText(
    join(cuaRoot, "test", "availability.test.ts"),
    'import { it } from "vitest";\nit("placeholder unavailable", () => {});\n',
  );
  for (const name of DOC_PLUGINS) {
    await writeJson(join(root, "apps/zcode-cli/packages", `${name}-plugin`, "package.json"), {
      name: `@zcode/${name}-plugin`,
      version: options.docPluginVersion ?? "0.2.1",
    });
  }
  for (const [relative, content] of Object.entries({
    "apps/zcode-cli/packages/node-repl-host/dist/old.js": "stale\n",
    "apps/zcode-cli/packages/cli/dist/old.js": "stale\n",
    "packages/desktop/bundled-agents/old.js": "stale\n",
    "packages/desktop/bundled-tools/old.js": "stale\n",
    "packages/desktop/out/old.js": "stale\n",
  })) {
    await writeText(join(root, relative), content);
  }
  const git = options.git ?? true;
  if (git) await initRepo(root);
  return { root, cuaRoot };
}

async function createFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcodepro-overlay-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const repoRoot = join(root, "repo");
  const zcodeproDir = join(root, "ZcodePro");
  if (options.repoGit ?? true) await createRepoFixture(repoRoot, options);
  else await createRepoFixture(repoRoot, { ...options, git: false });
  await createZcodeProFixture(zcodeproDir, options);
  return { root, repoRoot, zcodeproDir, cuaRoot: join(repoRoot, "packages", "zcode-cua") };
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function gitStatus(root) {
  return (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
}

async function snapshotTree(root) {
  const entries = {};
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const bytes = await readFile(path);
      entries[path.slice(root.length + 1)] = sha256(bytes);
    }
  }
  await visit(root);
  return entries;
}

test("apply publishes the ZcodePro runtime and keeps the fork entry points", async (t) => {
  const f = await createFixture(t);
  const result = await applyOverlay({
    repoRoot: f.repoRoot,
    zcodeproDir: f.zcodeproDir,
    env: WINDOWS_X64_ENV,
    now: () => new Date("2026-10-25T00:00:00.000Z"),
  });
  assert.equal(result.status, "applied");

  const manifest = await readJsonFile(join(f.cuaRoot, "package.json"));
  assert.equal(manifest.zcodeCuaPlaceholder, undefined);
  assert.deepEqual(manifest.zcodeCuaRuntime, {
    schema: 1,
    windows: {
      entry: "dist/windows-helper.js",
      nativeAddon: "build/Release/ax_native.node",
    },
  });
  assert.deepEqual(manifest.dependencies, { sharp: "0.34.5", express: "5.2.1" });
  assert.equal(manifest.scripts.build, "tsc --noEmit -p tsconfig.json");
  assert.equal(
    await readFile(join(f.cuaRoot, "index.js"), "utf8"),
    "export const runtime = 'real';\n",
  );

  // 文本文件统一写成 LF；二进制按原始字节复制。
  assert.equal(
    await readFile(join(f.cuaRoot, "dist", "windows-helper.js"), "utf8"),
    HELPER_ENTRY_LF,
  );
  const vendor = await readFile(join(f.cuaRoot, "vendor", "dist-index.js"), "utf8");
  assert.equal(vendor, "export const vendor = 1;\n");
  const addon = await readFile(join(f.cuaRoot, "build", "Release", "ax_native.node"));
  assert.equal(sha256(addon), sha256(x64PeBuffer()));

  // fork 自有入口保持不动。
  assert.equal(
    await readFile(join(f.cuaRoot, "vitest.config.ts"), "utf8"),
    'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({});\n',
  );
  assert.equal((await readJsonFile(join(f.cuaRoot, "tsconfig.json"))).include[0], "*.d.ts");

  // 3 条被 ZcodePro d.ts 漏掉的声明被补齐，且只补一次。
  const brokerTypes = await readFile(join(f.cuaRoot, "broker-server.d.ts"), "utf8");
  for (const name of [
    "resolveHelperAppName",
    "resolveCuaHelperInstallRoot",
    "standaloneHelperCandidatePaths",
  ]) {
    assert.equal(brokerTypes.match(new RegExp(`function ${name}\\b`, "g")).length, 1, name);
  }

  assert.equal(existsSync(join(f.cuaRoot, "test", "availability.test.ts")), false);
  assert.equal(existsSync(join(f.cuaRoot, "test", "overlay-contract.test.ts")), true);
  assert.equal(existsSync(join(f.cuaRoot, "node_modules")), false);

  const marker = await readJsonFile(join(f.cuaRoot, ".zcodepro-overlay.json"));
  assert.equal(marker.schema, 1);
  assert.equal(marker.producer.version, "0.6.5");
  assert.equal(marker.producer.helperVersion, "0.6.5");
  assert.deepEqual(marker.target, { os: "win32", arch: "x64" });
  assert.equal(marker.sha256.entry, sha256(Buffer.from(HELPER_ENTRY_LF)));
  assert.equal(marker.sha256.addon, sha256(x64PeBuffer()));
  assert.match(marker.zcodepro.head, /^[0-9a-f]{40}$/);
  assert.equal(marker.zcodepro.dirty, false);
  assert.equal(marker.appliedAt, "2026-10-25T00:00:00.000Z");

  // 首次应用清理旧生成目录，且不触碰受版本控制的文件。
  for (const relative of [
    "apps/zcode-cli/packages/node-repl-host/dist",
    "apps/zcode-cli/packages/cli/dist",
    "packages/desktop/bundled-agents",
    "packages/desktop/bundled-tools",
    "packages/desktop/out",
  ]) {
    assert.equal(existsSync(join(f.repoRoot, relative)), false, relative);
  }
});

test("apply is idempotent and reports no changes on the second run", async (t) => {
  const f = await createFixture(t);
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  const before = await snapshotTree(f.repoRoot);
  const markerBefore = await readFile(join(f.cuaRoot, ".zcodepro-overlay.json"), "utf8");
  const result = await applyOverlay({
    repoRoot: f.repoRoot,
    zcodeproDir: f.zcodeproDir,
    env: WINDOWS_X64_ENV,
  });
  assert.equal(result.status, "unchanged");
  assert.deepEqual(result.changedFiles, []);
  assert.equal(await readFile(join(f.cuaRoot, ".zcodepro-overlay.json"), "utf8"), markerBefore);
  assert.deepEqual(await snapshotTree(f.repoRoot), before);
});

test("apply refuses to overwrite local placeholder edits without a marker", async (t) => {
  const f = await createFixture(t);
  await writeText(join(f.cuaRoot, "index.js"), "export const runtime = 'edited';\n");
  await assert.rejects(
    applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV }),
    /local changes/,
  );
  assert.equal(
    await readFile(join(f.cuaRoot, "index.js"), "utf8"),
    "export const runtime = 'edited';\n",
  );
});

test("apply aborts on a sha256 mismatch and leaves the workspace untouched", async (t) => {
  const f = await createFixture(t, { manifestEntryHash: "0".repeat(64) });
  const before = await snapshotTree(f.repoRoot);
  await assert.rejects(
    applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV }),
    /sha256 mismatch/,
  );
  assert.deepEqual(await snapshotTree(f.repoRoot), before);
});

test("apply rejects non-Windows and non-x64 targets with actionable guidance", async (t) => {
  const f = await createFixture(t);
  for (const env of [
    { ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "x64" },
    { ZCODE_TARGET_OS: "darwin", ZCODE_TARGET_ARCH: "arm64" },
    { ZCODE_TARGET_OS: "win32", ZCODE_TARGET_ARCH: "arm64" },
  ]) {
    await assert.rejects(
      applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env }),
      (error) => {
        assert.match(error.message, /win32-x64/);
        assert.match(error.message, /ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64/);
        return true;
      },
    );
  }
  assert.equal(
    JSON.parse(await readFile(join(f.repoRoot, "packages", "zcode-cua", "package.json"), "utf8"))
      .zcodeCuaPlaceholder,
    true,
  );
});

test("apply rejects stale or drifting ZcodePro versions", async (t) => {
  const old = await createFixture(t, { version: "0.6.4" });
  await assert.rejects(
    applyOverlay({ repoRoot: old.repoRoot, zcodeproDir: old.zcodeproDir, env: WINDOWS_X64_ENV }),
    /0\.6\.4.*xnqycs\/ZcodePro/s,
  );

  const drift = await createFixture(t, { version: "0.6.5", helperVersion: "0.6.6" });
  await assert.rejects(
    applyOverlay({
      repoRoot: drift.repoRoot,
      zcodeproDir: drift.zcodeproDir,
      env: WINDOWS_X64_ENV,
    }),
    /version mismatch/,
  );
});

test("apply rejects an addon that is not a Windows x64 PE", async (t) => {
  const addonBytes = Buffer.from(x64PeBuffer());
  addonBytes.writeUInt16LE(0xaa64, 0x84);
  const f = await createFixture(t, {
    addonBytes,
    manifestAddonHash: sha256(addonBytes),
  });
  await assert.rejects(
    applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV }),
    /PE machine mismatch/,
  );
});

test("apply rejects a ZcodePro checkout with foreign or incomplete runtimes", async (t) => {
  const f = await createFixture(t);
  await writeJson(join(f.zcodeproDir, "runtimes", "zcode-cua", "package.json"), {
    name: "@zcode/zcode-cua-helper-runtime",
    version: "0.6.5",
  });
  await assert.rejects(
    applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV }),
    /unexpected package name/,
  );

  const missing = await createFixture(t);
  await rm(join(missing.zcodeproDir, "runtimes", "cua-helper", "dist"), {
    recursive: true,
    force: true,
  });
  await assert.rejects(
    applyOverlay({
      repoRoot: missing.repoRoot,
      zcodeproDir: missing.zcodeproDir,
      env: WINDOWS_X64_ENV,
    }),
    /missing/,
  );
});

test("apply rejects sharp/express versions that drift from the release contract", async (t) => {
  const sharp = await createFixture(t, { sharpVersion: "0.35.0" });
  await assert.rejects(
    applyOverlay({
      repoRoot: sharp.repoRoot,
      zcodeproDir: sharp.zcodeproDir,
      env: WINDOWS_X64_ENV,
    }),
    /sharp 0\.35\.0.*0\.34\.5/s,
  );

  const express = await createFixture(t, { expressVersion: "5.1.0" });
  await assert.rejects(
    applyOverlay({
      repoRoot: express.repoRoot,
      zcodeproDir: express.zcodeproDir,
      env: WINDOWS_X64_ENV,
    }),
    /express 5\.1\.0.*5\.2\.1/s,
  );
});

test("apply records a dirty ZcodePro checkout without failing", async (t) => {
  const f = await createFixture(t);
  await writeText(join(f.zcodeproDir, "untracked.txt"), "dirty\n");
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  const marker = await readJsonFile(join(f.cuaRoot, ".zcodepro-overlay.json"));
  assert.equal(marker.zcodepro.dirty, true);
});

test("apply only clears generated dirs when the ZcodePro identity changes", async (t) => {
  const f = await createFixture(t);
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  await writeText(join(f.repoRoot, "packages/desktop/out/fresh.js"), "fresh\n");
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  assert.equal(existsSync(join(f.repoRoot, "packages/desktop/out/fresh.js")), true);

  await writeText(
    join(f.zcodeproDir, "runtimes", "zcode-cua", "index.js"),
    "export const runtime = 'real';\n// bump\n",
  );
  await exec("git", ["add", "."], { cwd: f.zcodeproDir });
  await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "bump"],
    { cwd: f.zcodeproDir },
  );
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  assert.equal(existsSync(join(f.repoRoot, "packages/desktop/out/fresh.js")), false);
});

test("revert restores the placeholder package and leaves git clean", async (t) => {
  const f = await createFixture(t);
  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  const result = await revertOverlay({ repoRoot: f.repoRoot });
  assert.equal(result.status, "reverted");

  const manifest = await readJsonFile(join(f.cuaRoot, "package.json"));
  assert.equal(manifest.zcodeCuaPlaceholder, true);
  assert.equal(manifest.zcodeCuaRuntime, undefined);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(existsSync(join(f.cuaRoot, "test", "availability.test.ts")), true);
  assert.equal(existsSync(join(f.cuaRoot, "test", "overlay-contract.test.ts")), false);
  assert.equal(existsSync(join(f.cuaRoot, "vendor")), false);
  assert.equal(existsSync(join(f.cuaRoot, "dist")), false);
  assert.equal(existsSync(join(f.cuaRoot, "build")), false);
  assert.equal(existsSync(join(f.cuaRoot, ".zcodepro-overlay.json")), false);
  assert.equal(await gitStatus(f.repoRoot), "");
});

test("revert without an overlay reports nothing to do", async (t) => {
  const f = await createFixture(t);
  const result = await revertOverlay({ repoRoot: f.repoRoot });
  assert.equal(result.status, "not-applied");
  assert.equal(await gitStatus(f.repoRoot), "");
});

test("check reports alignment and never writes", async (t) => {
  const f = await createFixture(t);
  const before = await snapshotTree(f.repoRoot);
  const clean = await checkOverlay({
    repoRoot: f.repoRoot,
    zcodeproDir: f.zcodeproDir,
    env: WINDOWS_X64_ENV,
  });
  assert.equal(clean.applied, false);
  assert.equal(clean.producer.version, "0.6.5");
  assert.equal(clean.documentPlugins.length, 4);
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(await snapshotTree(f.repoRoot), before);

  await applyOverlay({ repoRoot: f.repoRoot, zcodeproDir: f.zcodeproDir, env: WINDOWS_X64_ENV });
  const applied = await checkOverlay({
    repoRoot: f.repoRoot,
    zcodeproDir: f.zcodeproDir,
    env: WINDOWS_X64_ENV,
  });
  assert.equal(applied.applied, true);

  const mismatched = await createFixture(t);
  const stale = await checkOverlay({
    repoRoot: mismatched.repoRoot,
    zcodeproDir: mismatched.zcodeproDir,
    env: WINDOWS_X64_ENV,
  });
  await writeJson(join(mismatched.zcodeproDir, "plugins", "documents-plugin", "package.json"), {
    name: "@zcode/documents-plugin",
    version: "0.3.0",
  });
  const warned = await checkOverlay({
    repoRoot: mismatched.repoRoot,
    zcodeproDir: mismatched.zcodeproDir,
    env: WINDOWS_X64_ENV,
  });
  assert.deepEqual(stale.warnings, []);
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /documents/);
});

test("check rejects unsupported targets and does not write", async (t) => {
  const f = await createFixture(t);
  const before = await snapshotTree(f.repoRoot);
  await assert.rejects(
    checkOverlay({
      repoRoot: f.repoRoot,
      zcodeproDir: f.zcodeproDir,
      env: { ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "x64" },
    }),
    /win32-x64/,
  );
  assert.deepEqual(await snapshotTree(f.repoRoot), before);
});

test("parseOverlayArgs accepts flags, mode words and rejects unknown input", () => {
  assert.deepEqual(parseOverlayArgs([]), {
    help: false,
    mode: "apply",
    repoRoot: undefined,
    zcodeproDir: undefined,
  });
  assert.deepEqual(parseOverlayArgs(["--check", "--zcodepro", "/pro", "--repo-root", "/repo"]), {
    help: false,
    mode: "check",
    repoRoot: "/repo",
    zcodeproDir: "/pro",
  });
  assert.equal(parseOverlayArgs(["--revert"]).mode, "revert");
  assert.equal(parseOverlayArgs(["--", "--check"]).mode, "check");
  assert.equal(parseOverlayArgs(["apply"]).mode, "apply");
  assert.throws(() => parseOverlayArgs(["--wat"]), /unknown argument/);
  assert.throws(() => parseOverlayArgs(["apply", "--revert"]), /conflicting modes/);
  assert.throws(() => parseOverlayArgs(["--zcodepro"]), /requires a value/);
});

test("CLI applies, checks and reverts a fixture checkout", async (t) => {
  const f = await createFixture(t);
  const run = (args) =>
    exec(
      process.execPath,
      [overlayScript, ...args, "--repo-root", f.repoRoot, "--zcodepro", f.zcodeproDir],
      {
        env: { ...process.env, ...WINDOWS_X64_ENV, ZCODEPRO_DIR: "" },
        timeout: 60_000,
      },
    );

  const applied = await run([]);
  assert.match(applied.stdout, /applied ZcodePro 0\.6\.5/);
  assert.match(applied.stdout, /pnpm install --no-frozen-lockfile/);

  const checked = await run(["--check"]);
  assert.match(checked.stdout, /overlay: applied/);
  assert.match(checked.stdout, /document plugins aligned/);

  await assert.rejects(
    exec(
      process.execPath,
      [overlayScript, "--check", "--repo-root", f.repoRoot, "--zcodepro", "/definitely/missing"],
      { env: { ...process.env, ...WINDOWS_X64_ENV, ZCODEPRO_DIR: "" } },
    ),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /ZcodePro directory not found/);
      return true;
    },
  );

  const reverted = await run(["--revert"]);
  assert.match(reverted.stdout, /reverted/);
  assert.equal(
    JSON.parse(await readFile(join(f.cuaRoot, "package.json"), "utf8")).zcodeCuaPlaceholder,
    true,
  );
});

test("CLI prints help without touching the workspace", async (t) => {
  const f = await createFixture(t);
  const before = await snapshotTree(f.repoRoot);
  const { stdout } = await exec(process.execPath, [overlayScript, "--help"], {
    env: { ...process.env, ZCODEPRO_DIR: "" },
  });
  assert.match(stdout, /xnqycs\/ZcodePro/);
  assert.match(stdout, /779bf88/);
  assert.match(stdout, /ZCODE_TARGET_OS=win32/);
  assert.deepEqual(await snapshotTree(f.repoRoot), before);
});
