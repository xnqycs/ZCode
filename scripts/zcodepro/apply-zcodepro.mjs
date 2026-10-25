#!/usr/bin/env node

/**
 * 把 ZcodePro 的 Computer Use 运行时叠加到 packages/zcode-cua。
 *
 * 产物来自闭源发行物，绝对不能进入本仓库的 git 历史。脚本只做构建时的本地叠加，
 * 并提供 --check / --revert；约束见 docs/desktop/zcodepro-overlay.md。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTargetPlatform } from "../../packages/desktop/scripts/target-platform.mjs";
import { inspectAgentCuaContracts } from "../../apps/zcode-cli/packages/cli/scripts/agent-cua-contracts.mjs";
import { OVERLAY_CONTRACT_TEST_SOURCE } from "./overlay-contract-test-source.mjs";

const PRODUCER_PACKAGE_NAME = "@zcode/zcode-cua";
const SUPPORTED_TARGET_KEY = "win32-x64";
const MIN_PRODUCER_VERSION = "0.6.5";
const EXPECTED_SHARP_VERSION = "0.34.5";
const EXPECTED_EXPRESS_VERSION = "5.2.1";
const MANIFEST_ENTRY = "dist/windows-helper.js";
const MANIFEST_ADDON = "build/Release/ax_native.node";
const PE_MACHINE_X64 = 0x8664;
const OVERLAY_MARKER = ".zcodepro-overlay.json";
const OVERLAY_CONTRACT_TEST = "test/overlay-contract.test.ts";
const PLACEHOLDER_AVAILABILITY_TEST = "test/availability.test.ts";
const DOCUMENT_PLUGINS = ["documents", "pdf", "presentations", "spreadsheets"];
const TEXT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".json", ".md"];
const CUA_RELATIVE = "packages/zcode-cua";
const GENERATED_DIRS = [
  "apps/zcode-cli/packages/node-repl-host/dist",
  "apps/zcode-cli/packages/cli/dist",
  "packages/desktop/bundled-agents",
  "packages/desktop/bundled-tools",
  "packages/desktop/out",
];
const OVERLAY_ARTIFACTS = [
  `${CUA_RELATIVE}/vendor`,
  `${CUA_RELATIVE}/dist`,
  `${CUA_RELATIVE}/build`,
  `${CUA_RELATIVE}/${OVERLAY_MARKER}`,
  `${CUA_RELATIVE}/${OVERLAY_CONTRACT_TEST}`,
];
const BROKER_SERVER_DTS_MISSING = [
  "export declare function resolveHelperAppName(env?: NodeJS.ProcessEnv): string;",
  "export declare function resolveCuaHelperInstallRoot(env: NodeJS.ProcessEnv): string | null;",
  "export declare function standaloneHelperCandidatePaths(env?: NodeJS.ProcessEnv): string[];",
];

class OverlayError extends Error {
  constructor(message) {
    super(message);
    this.name = "OverlayError";
  }
}

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isTextArtifact(name) {
  return TEXT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function toLf(buffer) {
  return Buffer.from(buffer.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(typeof value === "string" ? value.trim() : "");
  return match ? match.slice(1, 4).map((part) => Number.parseInt(part, 10)) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function assertAtLeastMinimumVersion(version, label) {
  const parsed = parseVersion(version);
  const minimum = parseVersion(MIN_PRODUCER_VERSION);
  if (!parsed) throw new OverlayError(`${label} has an unreadable version: ${String(version)}`);
  if (compareVersions(parsed, minimum) < 0) {
    throw new OverlayError(
      `${label} is ${version}, which is older than ${MIN_PRODUCER_VERSION}. ` +
        "Use the xnqycs/ZcodePro fork (a fresh clone or fetch of its main branch).",
    );
  }
}

function parsePeMachine(bytes, label) {
  if (bytes.length < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
    throw new OverlayError(`invalid PE header in ${label}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 6 ||
    bytes.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000"
  ) {
    throw new OverlayError(`invalid PE header in ${label}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

function assertSupportedTarget(env) {
  const target = getTargetPlatform(env);
  if (target.key !== SUPPORTED_TARGET_KEY) {
    throw new OverlayError(
      `unsupported target platform ${target.key}: ZcodePro overlay only supports ${SUPPORTED_TARGET_KEY}. ` +
        "Set ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64.",
    );
  }
  return target;
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new OverlayError(`failed to run git in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new OverlayError(
      `git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function readGitSourceIdentity(zcodeproDir) {
  const head = runGit(zcodeproDir, ["rev-parse", "HEAD"], { allowFailure: true });
  if (head.status !== 0) {
    throw new OverlayError(
      `${zcodeproDir} is not a usable git checkout; clone it with git so the overlay can record its HEAD`,
    );
  }
  const status = runGit(zcodeproDir, ["status", "--porcelain"]);
  return {
    head: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

async function readJsonFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new OverlayError(`missing ${label}: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new OverlayError(`invalid JSON in ${label}: ${path} (${error.message})`);
  }
}

async function readFileOrThrow(path, label) {
  try {
    return await readFile(path);
  } catch {
    throw new OverlayError(`missing ${label}: ${path}`);
  }
}

async function listFiles(root, base = "") {
  const entries = await readdir(join(root, base), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function validateZcodeProSource({ repoRoot, zcodeproDir }) {
  if (!existsSync(zcodeproDir)) {
    throw new OverlayError(`ZcodePro directory not found: ${zcodeproDir}`);
  }
  const producerRoot = join(zcodeproDir, "runtimes", "zcode-cua");
  const helperRoot = join(zcodeproDir, "runtimes", "cua-helper");
  const producerManifest = await readJsonFile(
    join(producerRoot, "package.json"),
    "ZcodePro runtimes/zcode-cua/package.json",
  );
  if (producerManifest.name !== PRODUCER_PACKAGE_NAME) {
    throw new OverlayError(
      `unexpected package name in runtimes/zcode-cua/package.json: ${String(producerManifest.name)}; ` +
        `expected ${PRODUCER_PACKAGE_NAME}`,
    );
  }
  assertAtLeastMinimumVersion(producerManifest.version, "runtimes/zcode-cua");

  const helperManifest = await readJsonFile(
    join(helperRoot, "runtime-manifest.json"),
    "ZcodePro runtimes/cua-helper/runtime-manifest.json",
  );
  const helperPackage = await readJsonFile(
    join(helperRoot, "package.json"),
    "ZcodePro runtimes/cua-helper/package.json",
  );
  if (helperPackage.version !== producerManifest.version) {
    throw new OverlayError(
      `version mismatch between ZcodePro runtimes: zcode-cua ${producerManifest.version} vs ` +
        `cua-helper ${String(helperPackage.version)}`,
    );
  }
  if (typeof helperManifest.packageVersion === "string") {
    if (helperManifest.packageVersion !== producerManifest.version) {
      throw new OverlayError(
        `version mismatch between ZcodePro runtime package (${producerManifest.version}) and ` +
          `runtime-manifest.json (${helperManifest.packageVersion})`,
      );
    }
  }
  if (helperManifest.packageName !== PRODUCER_PACKAGE_NAME) {
    throw new OverlayError(
      `unexpected packageName in runtime-manifest.json: ${String(helperManifest.packageName)}`,
    );
  }
  if (helperManifest.platform !== "win32" || helperManifest.arch !== "x64") {
    throw new OverlayError(
      `runtime-manifest.json targets ${String(helperManifest.platform)}-${String(helperManifest.arch)}; ` +
        "only win32-x64 is supported",
    );
  }
  if (helperManifest.entry !== MANIFEST_ENTRY || helperManifest.addon !== MANIFEST_ADDON) {
    throw new OverlayError(
      `runtime-manifest.json paths do not match the expected runtime contract: ` +
        `entry=${String(helperManifest.entry)} addon=${String(helperManifest.addon)}`,
    );
  }
  const electronVersion = helperManifest.electronVersion;
  if (typeof electronVersion !== "string" || !electronVersion.trim()) {
    throw new OverlayError("runtime-manifest.json is missing electronVersion");
  }
  const desktopPackage = await readJsonFile(
    join(repoRoot, "packages", "desktop", "package.json"),
    "packages/desktop/package.json",
  );
  const repoElectronVersion = desktopPackage.devDependencies?.electron;
  if (repoElectronVersion !== electronVersion) {
    throw new OverlayError(
      `electron version mismatch: runtime-manifest.json wants ${electronVersion}, ` +
        `packages/desktop declares ${String(repoElectronVersion)}`,
    );
  }

  const entryBytes = await readFileOrThrow(
    join(helperRoot, MANIFEST_ENTRY),
    "ZcodePro runtimes/cua-helper/dist/windows-helper.js",
  );
  const addonBytes = await readFileOrThrow(
    join(helperRoot, MANIFEST_ADDON),
    "ZcodePro runtimes/cua-helper/build/Release/ax_native.node",
  );
  const entryLf = toLf(entryBytes);
  const expected = helperManifest.sha256 ?? {};
  if (sha256(entryLf) !== expected.entry) {
    throw new OverlayError(
      `sha256 mismatch for dist/windows-helper.js after CRLF normalization: ` +
        `expected ${String(expected.entry)}, got ${sha256(entryLf)}`,
    );
  }
  if (sha256(addonBytes) !== expected.addon) {
    throw new OverlayError(
      `sha256 mismatch for build/Release/ax_native.node: expected ${String(expected.addon)}, ` +
        `got ${sha256(addonBytes)}`,
    );
  }
  const peMachine = parsePeMachine(addonBytes, "build/Release/ax_native.node");
  if (peMachine !== PE_MACHINE_X64) {
    throw new OverlayError(
      `PE machine mismatch: expected 0x${PE_MACHINE_X64.toString(16)}, got 0x${peMachine.toString(16)}`,
    );
  }

  const sharpVersion = await readHelperDependencyVersion(helperRoot, "sharp");
  if (sharpVersion !== EXPECTED_SHARP_VERSION) {
    throw new OverlayError(
      `ZcodePro helper bundles sharp ${sharpVersion}, but the release contract pins ` +
        `${EXPECTED_SHARP_VERSION}; update the overlay and docs/desktop/zcodepro-overlay.md together`,
    );
  }
  const expressVersion = await readHelperDependencyVersion(helperRoot, "express");
  if (expressVersion !== EXPECTED_EXPRESS_VERSION) {
    throw new OverlayError(
      `ZcodePro helper bundles express ${expressVersion}, but the release contract pins ` +
        `${EXPECTED_EXPRESS_VERSION}; update the overlay and docs/desktop/zcodepro-overlay.md together`,
    );
  }

  return {
    producerRoot,
    helperRoot,
    producerManifest,
    helperManifest,
    producerVersion: producerManifest.version,
    helperVersion: helperPackage.version,
    entryLf,
    addonBytes,
    source: readGitSourceIdentity(zcodeproDir),
  };
}

async function readHelperDependencyVersion(helperRoot, name) {
  const manifest = await readJsonFile(
    join(helperRoot, "node_modules", name, "package.json"),
    `ZcodePro runtimes/cua-helper/node_modules/${name}/package.json`,
  );
  return typeof manifest.version === "string" ? manifest.version : "<missing>";
}

async function buildDesiredFiles({ repoRoot, source }) {
  const files = new Map();
  const producerRoot = source.producerRoot;
  for (const entry of await readdir(producerRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    files.set(entry.name, await readFile(join(producerRoot, entry.name)));
  }
  let vendorFiles;
  try {
    vendorFiles = await listFiles(producerRoot, "vendor");
  } catch {
    throw new OverlayError(
      `missing ZcodePro runtimes/zcode-cua/vendor: ${join(producerRoot, "vendor")}`,
    );
  }
  for (const relative of vendorFiles) {
    files.set(relative, await readFile(join(producerRoot, ...relative.split("/"))));
  }
  for (const directory of ["dist", "build"]) {
    for (const relative of await listFiles(source.helperRoot, directory)) {
      files.set(relative, await readFile(join(source.helperRoot, ...relative.split("/"))));
    }
  }

  const forkPackage = await readJsonFile(
    join(repoRoot, CUA_RELATIVE, "package.json"),
    "packages/zcode-cua/package.json",
  );
  const packageJson = { ...source.producerManifest };
  delete packageJson.zcodeCuaPlaceholder;
  packageJson.zcodeCuaRuntime = {
    schema: 1,
    windows: { entry: MANIFEST_ENTRY, nativeAddon: MANIFEST_ADDON },
  };
  packageJson.dependencies = {
    ...packageJson.dependencies,
    sharp: EXPECTED_SHARP_VERSION,
    express: EXPECTED_EXPRESS_VERSION,
  };
  const forkBuildScript = forkPackage.scripts?.build;
  if (typeof forkBuildScript !== "string" || !forkBuildScript.trim()) {
    throw new OverlayError(
      "packages/zcode-cua/package.json is missing scripts.build; the root prepare step depends on it",
    );
  }
  packageJson.scripts = { ...packageJson.scripts, build: forkBuildScript };
  files.set("package.json", Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`));

  const brokerServerTypesPath = join(producerRoot, "broker-server.d.ts");
  let brokerServerTypes = toLf(
    await readFileOrThrow(brokerServerTypesPath, "broker-server.d.ts"),
  ).toString("utf8");
  for (const declaration of BROKER_SERVER_DTS_MISSING) {
    if (brokerServerTypes.includes(declaration)) continue;
    const separator = brokerServerTypes.endsWith("\n") ? "" : "\n";
    brokerServerTypes += `${separator}${declaration}\n`;
  }
  files.set("broker-server.d.ts", Buffer.from(brokerServerTypes));

  files.set(OVERLAY_CONTRACT_TEST, Buffer.from(OVERLAY_CONTRACT_TEST_SOURCE));

  const normalized = new Map();
  for (const [relative, bytes] of files) {
    const name = relative.split("/").at(-1) ?? relative;
    normalized.set(relative, isTextArtifact(name) ? toLf(bytes) : bytes);
  }
  return normalized;
}

function buildMarker({ zcodeproDir, source, target, appliedAt }) {
  return {
    schema: 1,
    zcodepro: {
      path: zcodeproDir,
      head: source.source.head,
      dirty: source.source.dirty,
    },
    producer: {
      version: source.producerVersion,
      helperVersion: source.helperVersion,
    },
    target: { os: target.os, arch: target.arch },
    sha256: {
      entry: sha256(source.entryLf),
      addon: sha256(source.addonBytes),
    },
    appliedAt,
  };
}

function sameSourceIdentity(left, right) {
  if (!left) return false;
  return (
    left.zcodepro?.head === right.zcodepro?.head &&
    left.zcodepro?.dirty === right.zcodepro?.dirty &&
    left.producer?.version === right.producer?.version &&
    left.producer?.helperVersion === right.producer?.helperVersion &&
    left.target?.os === right.target?.os &&
    left.target?.arch === right.target?.arch &&
    left.sha256?.entry === right.sha256?.entry &&
    left.sha256?.addon === right.sha256?.addon
  );
}

async function bytesEqual(path, expected) {
  try {
    return (await readFile(path)).equals(expected);
  } catch {
    return false;
  }
}

async function removeGeneratedDirs(repoRoot, log) {
  const removed = [];
  for (const relative of GENERATED_DIRS) {
    const absolute = join(repoRoot, ...relative.split("/"));
    if (!existsSync(absolute)) continue;
    const ignored = runGit(repoRoot, ["check-ignore", "-q", "--", relative], {
      allowFailure: true,
    });
    if (ignored.status !== 0) {
      log(`skip ${relative}: not ignored by git`);
      continue;
    }
    await rm(absolute, { recursive: true, force: true });
    removed.push(relative);
  }
  return removed;
}

async function readMarker(repoRoot) {
  const markerPath = join(repoRoot, CUA_RELATIVE, OVERLAY_MARKER);
  if (!existsSync(markerPath)) return undefined;
  try {
    return JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function assertNoForeignLocalChanges(repoRoot) {
  const status = runGit(repoRoot, ["status", "--porcelain", "--", CUA_RELATIVE, "pnpm-lock.yaml"]);
  if (status.stdout.trim()) {
    throw new OverlayError(
      "packages/zcode-cua or pnpm-lock.yaml has local changes and no overlay marker exists; " +
        "commit or stash them before applying the overlay",
    );
  }
}

export async function applyOverlay({
  repoRoot,
  zcodeproDir,
  env = process.env,
  now = () => new Date(),
  log = () => {},
}) {
  const target = assertSupportedTarget(env);
  if (!zcodeproDir) {
    throw new UsageError("--zcodepro <dir> or ZCODEPRO_DIR is required");
  }
  const previousMarker = await readMarker(repoRoot);
  if (!previousMarker) await assertNoForeignLocalChanges(repoRoot);
  const branch = runGit(repoRoot, ["branch", "--show-current"], { allowFailure: true });
  if (["main", "master"].includes(branch.stdout.trim())) {
    log(
      `warning: applying the overlay on ${branch.stdout.trim()}; build on a dedicated branch or worktree ` +
        "so the closed-source runtime cannot be committed by accident",
    );
  }

  const source = await validateZcodeProSource({ repoRoot, zcodeproDir });
  const desired = await buildDesiredFiles({ repoRoot, source });
  const marker = buildMarker({
    zcodeproDir,
    source,
    target,
    appliedAt: now().toISOString(),
  });
  const identityChanged = !sameSourceIdentity(previousMarker, marker);
  if (identityChanged) {
    const removed = await removeGeneratedDirs(repoRoot, log);
    if (removed.length > 0) log(`removed stale generated dirs: ${removed.join(", ")}`);
  }

  const changedFiles = [];
  for (const [relative, bytes] of desired) {
    const absolute = join(repoRoot, CUA_RELATIVE, ...relative.split("/"));
    if (await bytesEqual(absolute, bytes)) continue;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    changedFiles.push(relative);
  }
  if (existsSync(join(repoRoot, CUA_RELATIVE, ...PLACEHOLDER_AVAILABILITY_TEST.split("/")))) {
    await rm(join(repoRoot, CUA_RELATIVE, ...PLACEHOLDER_AVAILABILITY_TEST.split("/")), {
      force: true,
    });
    changedFiles.push(PLACEHOLDER_AVAILABILITY_TEST);
  }

  const effectiveMarker =
    identityChanged || !previousMarker
      ? marker
      : { ...marker, appliedAt: previousMarker.appliedAt };
  const markerPath = join(repoRoot, CUA_RELATIVE, OVERLAY_MARKER);
  const markerBytes = Buffer.from(`${JSON.stringify(effectiveMarker, null, 2)}\n`);
  const markerChanged = !(await bytesEqual(markerPath, markerBytes));
  if (markerChanged) await writeFile(markerPath, markerBytes);

  return {
    status: changedFiles.length === 0 && !markerChanged ? "unchanged" : "applied",
    marker: effectiveMarker,
    changedFiles,
  };
}

export async function checkOverlay({ repoRoot, zcodeproDir, env = process.env }) {
  const target = assertSupportedTarget(env);
  if (!zcodeproDir) throw new UsageError("--zcodepro <dir> or ZCODEPRO_DIR is required");
  const source = await validateZcodeProSource({ repoRoot, zcodeproDir });
  const desired = await buildDesiredFiles({ repoRoot, source });
  const marker = await readMarker(repoRoot);

  let applied = Boolean(marker);
  const missing = [];
  for (const [relative, bytes] of desired) {
    if (await bytesEqual(join(repoRoot, CUA_RELATIVE, ...relative.split("/")), bytes)) continue;
    applied = false;
    missing.push(relative);
  }
  if (existsSync(join(repoRoot, CUA_RELATIVE, ...PLACEHOLDER_AVAILABILITY_TEST.split("/")))) {
    applied = false;
  }

  const documentPlugins = [];
  const warnings = [];
  for (const name of DOCUMENT_PLUGINS) {
    const forkManifest = await readOptionalJson(
      join(repoRoot, "apps", "zcode-cli", "packages", `${name}-plugin`, "package.json"),
    );
    const zcodeProManifest = await readOptionalJson(
      join(zcodeproDir, "plugins", `${name}-plugin`, "package.json"),
    );
    const forkVersion = forkManifest?.version;
    const zcodeProVersion = zcodeProManifest?.version;
    const aligned = typeof forkVersion === "string" && forkVersion === zcodeProVersion;
    documentPlugins.push({ name, forkVersion, zcodeProVersion, aligned });
    if (typeof zcodeProVersion !== "string") {
      warnings.push(`${name}: ZcodePro plugin manifest is missing, cannot compare versions`);
    } else if (typeof forkVersion !== "string") {
      warnings.push(`${name}: bundled plugin manifest is missing, cannot compare versions`);
    } else if (!aligned) {
      warnings.push(
        `${name}: bundled version ${forkVersion} differs from ZcodePro ${zcodeProVersion}`,
      );
    }
  }

  const agentContracts = await inspectAgentCuaContracts(join(repoRoot, CUA_RELATIVE));
  if (!agentContracts.constantMatchesPlaceholder) {
    warnings.push(
      `agent contract: frame integrity key ${String(agentContracts.frameIntegrityKey)} ` +
        `differs from placeholder ${String(agentContracts.placeholderFrameIntegrityKey)}`,
    );
  }

  return {
    applied,
    missing,
    marker,
    target,
    producer: {
      version: source.producerVersion,
      helperVersion: source.helperVersion,
      head: source.source.head,
      dirty: source.source.dirty,
      sha256: { entry: sha256(source.entryLf), addon: sha256(source.addonBytes) },
    },
    documentPlugins,
    agentContracts,
    warnings,
  };
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function revertOverlay({ repoRoot, log = () => {} }) {
  const marker = await readMarker(repoRoot);
  if (!marker) {
    return { status: "not-applied", removedGeneratedDirs: [] };
  }
  runGit(repoRoot, ["checkout", "--", CUA_RELATIVE]);
  const lockfileTracked = runGit(repoRoot, ["ls-files", "--error-unmatch", "pnpm-lock.yaml"], {
    allowFailure: true,
  });
  if (lockfileTracked.status === 0) {
    runGit(repoRoot, ["checkout", "--", "pnpm-lock.yaml"]);
  }
  for (const relative of OVERLAY_ARTIFACTS) {
    await rm(join(repoRoot, ...relative.split("/")), { recursive: true, force: true });
  }
  const removedGeneratedDirs = await removeGeneratedDirs(repoRoot, log);
  const status = runGit(repoRoot, ["status", "--porcelain", "--", CUA_RELATIVE, "pnpm-lock.yaml"]);
  if (status.stdout.trim()) {
    throw new OverlayError(
      `revert left tracked changes behind:\n${status.stdout.trim()}\n` +
        "inspect packages/zcode-cua and pnpm-lock.yaml before continuing",
    );
  }
  return { status: "reverted", removedGeneratedDirs };
}

export function parseOverlayArgs(argv) {
  const parsed = { help: false, mode: "apply", repoRoot: undefined, zcodeproDir: undefined };
  const modes = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    // pnpm 会把 `pnpm <script> -- <args>` 的 `--` 透传给脚本，跳过它。
    if (argument === "--") continue;
    if (argument === "--check" || argument === "--revert" || argument === "apply") {
      modes.push(argument === "--check" ? "check" : argument === "--revert" ? "revert" : "apply");
      continue;
    }
    if (argument === "--zcodepro" || argument === "--repo-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a value`);
      }
      if (argument === "--zcodepro") parsed.zcodeproDir = value;
      else parsed.repoRoot = value;
      index += 1;
      continue;
    }
    throw new UsageError(`unknown argument: ${argument}`);
  }
  if (modes.length > 1) {
    throw new UsageError("conflicting modes: choose one of apply, --check, --revert");
  }
  if (modes.length === 1) parsed.mode = modes[0];
  return parsed;
}

const USAGE = `Usage: node scripts/zcodepro/apply-zcodepro.mjs [apply|--check|--revert] [options]

Overlay the ZcodePro Computer Use runtime onto packages/zcode-cua (win32-x64 builds only).
Source: git clone git@github.com:xnqycs/ZcodePro.git  (baseline commit 779bf88)

Options:
  --zcodepro <dir>   ZcodePro checkout (or set ZCODEPRO_DIR)
  --repo-root <dir>  repository root to operate on (defaults to this checkout)
  --check            validate ZcodePro and report overlay state without writing
  --revert           restore packages/zcode-cua and pnpm-lock.yaml from git
  -h, --help         show this help

The target platform comes from ZCODE_TARGET_OS / ZCODE_TARGET_ARCH. Non-win32-x64
targets are rejected; set ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64 to proceed.
After apply run: pnpm install --no-frozen-lockfile, then your usual Windows build.
`;

async function runCli(argv) {
  const parsed = parseOverlayArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const repoRoot = parsed.repoRoot
    ? resolve(parsed.repoRoot)
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const zcodeproDir = resolve(parsed.zcodeproDir ?? process.env.ZCODEPRO_DIR ?? "");
  const log = (message) => process.stdout.write(`[zcodepro-overlay] ${message}\n`);

  if (parsed.mode === "revert") {
    const result = await revertOverlay({ repoRoot, log });
    if (result.status === "not-applied") {
      log("nothing to revert (no overlay marker found)");
    } else {
      log("reverted packages/zcode-cua and pnpm-lock.yaml");
    }
    return 0;
  }

  if (!parsed.zcodeproDir && !process.env.ZCODEPRO_DIR) {
    throw new UsageError("--zcodepro <dir> or ZCODEPRO_DIR is required");
  }

  if (parsed.mode === "check") {
    const report = await checkOverlay({ repoRoot, zcodeproDir });
    log(
      `ZcodePro ok: ${report.producer.version} head=${report.producer.head.slice(0, 7)} ` +
        `dirty=${report.producer.dirty}`,
    );
    log(`overlay: ${report.applied ? "applied" : "not applied"}`);
    log(
      `agent contracts: ${
        report.agentContracts.derivable
          ? "derivable"
          : `not derivable (${report.agentContracts.reason})`
      }`,
    );
    const aligned = report.documentPlugins.filter((plugin) => plugin.aligned).length;
    log(`document plugins aligned: ${aligned}/${report.documentPlugins.length}`);
    for (const warning of report.warnings) log(`warning: ${warning}`);
    return 0;
  }

  const result = await applyOverlay({ repoRoot, zcodeproDir, log });
  if (result.status === "unchanged") {
    log("already applied, no changes");
  } else {
    log(
      `applied ZcodePro ${result.marker.producer.version} ` +
        `(${result.marker.target.os}-${result.marker.target.arch}) -> ${CUA_RELATIVE}`,
    );
    if (result.changedFiles.length > 0) {
      log(`updated ${result.changedFiles.length} file(s)`);
    }
  }
  log("Next steps:");
  log("  1. pnpm install --no-frozen-lockfile");
  log("  2. build the Windows x64 package with your usual preview command");
  return 0;
}

const isEntryPoint =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    const prefix = error instanceof UsageError ? "usage error" : "error";
    process.stderr.write(`[zcodepro-overlay] ${prefix}: ${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(USAGE);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
