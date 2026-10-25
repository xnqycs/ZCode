import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertBundledHostInvariants,
  createVendorEmbedPlugin,
  loadVendorEmbedTransform,
  transformVendorForEmbedding,
} from "../scripts/vendor-embed.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "../../../..");

const BANNER_IMPORT =
  'import { createRequire as __zcodeCreateRequire } from "node:module";';
const BANNER_REQUIRE = "const require = __zcodeCreateRequire(import.meta.url);";
const BANNER = `${BANNER_IMPORT}\n${BANNER_REQUIRE}\n`;
const WORKER_BLOCK = `if (!isMainThread && isWorkerCallData(workerData)) {
  const label = \`worker \${1 + 1}\`;
  // } 注释里的花括号不应破坏配平
  void executeJsInWorker({ code: label });
}
`;
const MAIN_BLOCK = `if (isMainThread && await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => process.stderr.write(\`boom \${error}\`));
}
`;

const VENDOR_FIXTURE = `${BANNER}var cuaRuntime = { kind: "cua" };
function main() { return cuaRuntime; }
function executeJsInWorker(data) { return new Worker(new URL(import.meta.url), { workerData: data }); }
function isWorkerCallData(value) { return value?.kind === "zcode-node-repl-call"; }
${WORKER_BLOCK}function isDirectMcpEntrypoint(importMetaUrl, argvPath) { return importMetaUrl === argvPath; }
${MAIN_BLOCK}export { main };
`;

const NODE_REQUIRE_BANNER = `${BANNER_IMPORT}
const require = __zcodeCreateRequire(import.meta.url);`;

const runNodeCheck = (path: string) => {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
};

describe("vendor embedding transform", () => {
  it("strips the banner and both top-level entry blocks", async () => {
    const transformed = await transformVendorForEmbedding(VENDOR_FIXTURE);

    expect(transformed).not.toContain(BANNER_IMPORT);
    expect(transformed).not.toContain(BANNER_REQUIRE);
    expect(transformed).not.toContain("if (!isMainThread");
    expect(transformed).not.toContain("isDirectMcpEntrypoint(import.meta.url");
    expect(transformed).toContain("var cuaRuntime");
    expect(transformed).toContain("function isWorkerCallData");
    expect(transformed).not.toContain("void executeJsInWorker({ code: label });");
  });

  it("normalizes CRLF before matching the banner", async () => {
    const transformed = await transformVendorForEmbedding(VENDOR_FIXTURE.replaceAll("\n", "\r\n"));
    expect(transformed).not.toContain("\r");
    expect(transformed).not.toContain("isDirectMcpEntrypoint(import.meta.url");
  });

  it("fails when the banner import is missing", async () => {
    const source = VENDOR_FIXTURE.replace(`${BANNER_IMPORT}\n`, "");
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(
      /banner.*createRequire import.*应恰好命中 1 次.*实际 0 次/u,
    );
  });

  it("fails when the banner appears twice", async () => {
    await expect(transformVendorForEmbedding(`${BANNER}${VENDOR_FIXTURE}`)).rejects.toThrow(
      /banner.*应恰好命中 1 次.*实际 2 次/u,
    );
  });

  it("fails when the worker entry block is missing", async () => {
    const source = VENDOR_FIXTURE.replace(WORKER_BLOCK, "");
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(
      /工作线程入口块.*应恰好命中 1 次.*实际 0 次/u,
    );
  });

  it("fails when the main entry block appears twice", async () => {
    const source = VENDOR_FIXTURE.replace("export { main };", `${MAIN_BLOCK}export { main };`);
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(
      /主入口块.*应恰好命中 1 次.*实际 2 次/u,
    );
  });

  it("fails when the worker entry block is unbalanced", async () => {
    const source = VENDOR_FIXTURE.replace(
      "  void executeJsInWorker({ code: label });\n}",
      "  void executeJsInWorker({ code: label });",
    );
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(/括号不配平/u);
  });

  it("fails when a top-level await survives the transform", async () => {
    const source = VENDOR_FIXTURE.replace(
      "export { main };",
      "await Promise.resolve();\nexport { main };",
    );
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(/top-level await/iu);
  });

  it("fails when a main-entry guard call survives the transform", async () => {
    const source = VENDOR_FIXTURE.replace(
      "export { main };",
      "void isDirectMcpEntrypoint(import.meta.url, process.argv[1]);\nexport { main };",
    );
    await expect(transformVendorForEmbedding(source)).rejects.toThrow(
      /isDirectMcpEntrypoint\(import\.meta\.url/u,
    );
  });

  it("returns undefined when the placeholder package has no vendor bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-vendor-embed-load-"));
    try {
      expect(loadVendorEmbedTransform(directory)).toBeUndefined();
      await writeFile(join(directory, "dist-index.js"), "export {};\n");
      expect(loadVendorEmbedTransform(directory)).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns the vendor path when the overlay provides vendor/dist-index.js", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-vendor-embed-load-"));
    try {
      const vendorDirectory = join(directory, "vendor");
      await mkdir(vendorDirectory, { recursive: true });
      await writeFile(join(vendorDirectory, "dist-index.js"), "export {};\n");
      expect(loadVendorEmbedTransform(directory)).toEqual({
        vendorPath: join(vendorDirectory, "dist-index.js"),
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

// 构建级对照：同一份"宿主入口 + 假 vendor"在不加插件时能稳定复现重复 import，
// 加上插件后通过 node --check 且只剩一套入口逻辑。
describe("vendor embedding esbuild plugin", () => {
  let fixtureRoot = "";
  let vendorPath = "";

  const hostEntry = `import { createComputerUseRuntime } from "./vendor/dist-index.js";
const WORKER_KIND = "zcode-node-repl-call";
function isWorkerCallData(value) { return value?.kind === WORKER_KIND; }
function executeJsInWorker(data) { return new Worker(new URL(import.meta.url), { workerData: data }); }
function main() { executeJsInWorker({}); return createComputerUseRuntime(); }
function isDirectMcpEntrypoint(importMetaUrl, argvPath) { return importMetaUrl === argvPath; }
if (!isMainThread && isWorkerCallData(workerData)) { main(); }
if (isMainThread && await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) { void main(); }
export { main };
`;

  const vendorSource = `${NODE_REQUIRE_BANNER}
const WORKER_KIND = "zcode-node-repl-call";
function isWorkerCallData(value) { return value?.kind === WORKER_KIND; }
function executeJsInWorker(data) { return new Worker(new URL(import.meta.url), { workerData: data }); }
function main() { return { cua: true }; }
export function createComputerUseRuntime() { return { requireType: typeof require }; }
if (!isMainThread && isWorkerCallData(workerData)) { executeJsInWorker(workerData); }
if (isMainThread && await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) { void main(); }
export { main };
`;

  const buildFixture = async (outfile: string, withPlugin: boolean) => {
    await build({
      absWorkingDir: fixtureRoot,
      banner: { js: NODE_REQUIRE_BANNER },
      bundle: true,
      entryPoints: [join(fixtureRoot, "host-entry.js")],
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
      outfile,
      platform: "node",
      target: "node24",
      ...(withPlugin
        ? { plugins: [createVendorEmbedPlugin({ outfile, vendorPath })] }
        : {}),
    });
  };

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "zcode-vendor-embed-build-"));
    vendorPath = join(fixtureRoot, "vendor", "dist-index.js");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(fixtureRoot, "vendor"), { recursive: true });
    await writeFile(join(fixtureRoot, "host-entry.js"), hostEntry);
    await writeFile(vendorPath, vendorSource);
  });

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true });
  });

  it("reproduces the duplicate banner import and entry guards without the plugin", async () => {
    const outfile = join(fixtureRoot, "without-plugin.mjs");
    await buildFixture(outfile, false);
    const bundle = await readFile(outfile, "utf8");

    expect(bundle.split(BANNER_IMPORT).length - 1).toBe(2);
    expect(bundle.match(/\bisDirectMcpEntrypoint\d*\(import\.meta\.url/gu)).toHaveLength(2);
    expect(bundle.match(/new Worker\d*\(/gu)).toHaveLength(2);

    const probe = runNodeCheck(outfile);
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain("__zcodeCreateRequire' has already been declared");
  });

  it("emits a single host entry surface with the plugin", async () => {
    const outfile = join(fixtureRoot, "with-plugin.mjs");
    await buildFixture(outfile, true);
    const bundle = await readFile(outfile, "utf8");

    expect(runNodeCheck(outfile)).toEqual({ status: 0, stderr: "" });
    expect(() => assertBundledHostInvariants(bundle)).not.toThrow();
    expect(bundle.split(BANNER_IMPORT).length - 1).toBe(1);
    expect(bundle.split("isDirectMcpEntrypoint(import.meta.url").length - 1).toBe(1);
    expect(bundle.match(/new Worker\d*\(/gu)).toHaveLength(1);
    expect(bundle).not.toContain("isDirectMcpEntrypoint2");
    expect(bundle).not.toContain("Worker2");
  });
});

const realVendorPath = process.env.ZCODEPRO_DIR
  ? join(process.env.ZCODEPRO_DIR, "runtimes", "zcode-cua", "vendor", "dist-index.js")
  : join(repoRoot, "packages", "zcode-cua", "vendor", "dist-index.js");

describe.skipIf(!existsSync(realVendorPath))(
  "real ZcodePro vendor (requires ZCODEPRO_DIR or an applied overlay)",
  () => {
    it("matches every anchor exactly once on the real vendor bundle", async () => {
      const source = await readFile(realVendorPath, "utf8");
      const transformed = await transformVendorForEmbedding(source);

      expect(transformed).not.toContain("__zcodeCreateRequire");
      expect(transformed).not.toContain("if (!isMainThread && isWorkerCallData(workerData))");
      expect(transformed).not.toContain("isDirectMcpEntrypoint(import.meta.url");
      expect(transformed).toContain("function createComputerUseRuntime");
      expect(transformed.length).toBeGreaterThan(1024);
      expect(transformed.length).toBeLessThan(source.length);
    });
  },
);
