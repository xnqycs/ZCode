import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 桌面 agent 的 CJS 单文件 bundle 不能把 ZcodePro 的 vendor/dist-index.js 打进来：
 * 该文件是 ESM 提取物，末尾有 top-level await，esbuild 的 cjs 输出直接拒绝。
 *
 * agent 图只用到 @zcode/zcode-cua 的两个子路径，而这两个契约几乎自包含：
 * - frame-contract.js 只从 vendor 取一个字符串常量；
 * - request-access-contract.js 是对 vendor 的纯转发，块内只依赖 Zod 命名空间。
 *
 * 因此仅当 overlay 已应用（vendor 存在）时，把这两个 specifier 解析到构建期从真实文件
 * 派生的无 vendor 副本。派生必须跟随 ZcodePro 更新，出现无法机械识别的变化时直接失败，
 * 不能退回占位契约（占位 attest 恒失败，会让每张 Computer Use 截图被拒绝）。
 */

const FRAME_CONTRACT_SPECIFIER = "@zcode/zcode-cua/frame-contract";
const REQUEST_ACCESS_CONTRACT_SPECIFIER = "@zcode/zcode-cua/request-access-contract";

export const AGENT_CUA_CONTRACT_SPECIFIERS = [
  FRAME_CONTRACT_SPECIFIER,
  REQUEST_ACCESS_CONTRACT_SPECIFIER,
];

export const AGENT_CUA_NAMESPACE = "zp-agent-cua";

const VENDOR_ENTRY = "vendor/dist-index.js";
const FRAME_CONTRACT_FILE = "frame-contract.js";
const REQUEST_ACCESS_CONTRACT_FILE = "request-access-contract.js";
const FRAME_VENDOR_IMPORT =
  'import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "./vendor/dist-index.js";';
const FRAME_CONSTANT_NAME = "OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY";
const FRAME_EXPORT = `export { ${FRAME_CONSTANT_NAME} };`;
const FRAME_CONSTANT_PATTERN = /^var OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "([^"]+)";$/gm;
// 生产端的 MCP 图片块是 { type, data, mimeType }，而 formatMcpToolResult 会把它改写成
// 模型形状 { type, mediaType, dataUrl }（apps/zcode-cli/packages/core/src/mcp/index.ts）。
// 桌面 agent 的 attest / 投影都跑在改写后的内容上，所以派生契约必须同时识别两种形状。
const FRAME_IMAGE_BLOCK_DATA_CHECK = 'typeof block.data === "string" &&\n    block.data.length > 0';
const FRAME_IMAGE_BLOCK_DATA_URL_CHECK =
  '((typeof block.data === "string" &&\n      block.data.length > 0) ||\n' +
  '      (typeof block.dataUrl === "string" &&\n        block.dataUrl.length > 0))';
const REQUEST_ACCESS_START_MARKER = "var CUA_REQUEST_ACCESS_STATUS_META_KEY =";
const REQUEST_ACCESS_END_MARKER = "function attachCuaRequestAccessStatusMeta(";
const REQUEST_ACCESS_BINDING_PATTERN = /external_exports\d+/g;
const REQUEST_ACCESS_DECLARATION_PATTERN = /^(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const REQUEST_ACCESS_DECLARATIONS = [
  "CUA_REQUEST_ACCESS_STATUS_META_KEY",
  "cuaRequestAccessStatusSchema",
  "readCuaRequestAccessStatus",
];
const REQUEST_ACCESS_EXPORTS = `export { ${REQUEST_ACCESS_DECLARATIONS.join(", ")} };`;
const VIRTUAL_PATHS = {
  [FRAME_CONTRACT_SPECIFIER]: "frame-contract",
  [REQUEST_ACCESS_CONTRACT_SPECIFIER]: "request-access-contract",
};

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function assertUniqueMarker(source, marker, label) {
  const count = countOccurrences(source, marker);
  if (count !== 1) {
    throw new Error(`${label} must appear exactly once, found ${count}`);
  }
}

function widenFrameImageBlockMatcher(source) {
  const count = countOccurrences(source, FRAME_IMAGE_BLOCK_DATA_CHECK);
  if (count !== 1) {
    throw new Error(
      `expected exactly one isImageBlock data check in ${FRAME_CONTRACT_FILE}, found ${count}: ` +
        "frame-contract 的 isImageBlock 形态变了，需要重新审视",
    );
  }
  return source.replace(FRAME_IMAGE_BLOCK_DATA_CHECK, FRAME_IMAGE_BLOCK_DATA_URL_CHECK);
}

export function extractFrameContract(source, vendorSource) {
  const vendorReferences = countOccurrences(source, "./vendor/");
  if (vendorReferences !== 1) {
    throw new Error(
      `${FRAME_CONTRACT_FILE} must reference ./vendor exactly once, found ${vendorReferences}: ` +
        "the contract gained a vendor dependency, re-audit the extraction",
    );
  }
  const lines = source.split("\n");
  const vendorLines = lines.filter((line) => line.includes("./vendor/"));
  if (vendorLines.length !== 1 || vendorLines[0] !== FRAME_VENDOR_IMPORT) {
    throw new Error(
      `${FRAME_CONTRACT_FILE} vendor import is not the exact expected line ` +
        `(${FRAME_VENDOR_IMPORT}); the contract gained a vendor dependency, ` +
        "re-audit the extraction",
    );
  }

  const constantMatches = [...vendorSource.matchAll(FRAME_CONSTANT_PATTERN)];
  if (constantMatches.length !== 1) {
    throw new Error(
      `expected exactly one var ${FRAME_CONSTANT_NAME} in ${VENDOR_ENTRY}, ` +
        `found ${constantMatches.length}`,
    );
  }
  if (!source.includes(FRAME_EXPORT)) {
    throw new Error(
      `${FRAME_CONTRACT_FILE} no longer exports ${FRAME_CONSTANT_NAME}; ` +
        "the contract export surface changed",
    );
  }

  const derived = lines
    .map((line) =>
      line === FRAME_VENDOR_IMPORT
        ? `const ${FRAME_CONSTANT_NAME} = "${constantMatches[0][1]}";`
        : line,
    )
    .join("\n");
  if (derived.includes("./vendor/")) {
    throw new Error(`${FRAME_CONTRACT_FILE} derivation left a vendor reference behind`);
  }
  return widenFrameImageBlockMatcher(derived);
}

export function extractRequestAccessContract(vendorSource) {
  assertUniqueMarker(vendorSource, REQUEST_ACCESS_START_MARKER, "request-access start marker");
  assertUniqueMarker(vendorSource, REQUEST_ACCESS_END_MARKER, "request-access end marker");
  const start = vendorSource.indexOf(REQUEST_ACCESS_START_MARKER);
  const end = vendorSource.indexOf(REQUEST_ACCESS_END_MARKER);
  if (start >= end) {
    throw new Error("request-access block markers are out of order");
  }

  const block = vendorSource.slice(start, end);
  const bindings = [...new Set(block.match(REQUEST_ACCESS_BINDING_PATTERN) ?? [])];
  if (bindings.length !== 1) {
    throw new Error(
      "request-access block must use exactly one external_exports binding, " +
        `found ${bindings.length}: ${bindings.join(", ") || "<none>"}`,
    );
  }
  const declarations = [...block.matchAll(REQUEST_ACCESS_DECLARATION_PATTERN)].map(
    (match) => match[1],
  );
  if (
    declarations.length !== REQUEST_ACCESS_DECLARATIONS.length ||
    !REQUEST_ACCESS_DECLARATIONS.every((name) => declarations.includes(name))
  ) {
    throw new Error(
      `request-access block top-level declarations changed: ${declarations.join(", ") || "<none>"}` +
        `; expected ${REQUEST_ACCESS_DECLARATIONS.join(", ")}`,
    );
  }

  const body = block.split(bindings[0]).join("z").trimEnd();
  return `import { z } from "zod";\n\n${body}\n\n${REQUEST_ACCESS_EXPORTS}\n`;
}

function assertForwarderExports(source, specifier) {
  for (const name of REQUEST_ACCESS_DECLARATIONS) {
    if (!source.includes(name)) {
      throw new Error(
        `${REQUEST_ACCESS_CONTRACT_FILE} no longer forwards ${name}; ` +
          `re-audit ${specifier} before bundling the desktop agent`,
      );
    }
  }
}

/**
 * 未叠加（vendor 不存在）时返回 undefined，构建保持原样。
 * 叠加后返回两个 specifier 到派生源码的映射，由 esbuild 插件使用。
 */
export async function loadAgentCuaContractOverrides(cuaPackageRoot) {
  const vendorPath = join(cuaPackageRoot, VENDOR_ENTRY);
  if (!existsSync(vendorPath)) return undefined;

  const [frameSource, requestAccessSource, vendorSource] = await Promise.all([
    readFile(join(cuaPackageRoot, FRAME_CONTRACT_FILE), "utf8"),
    readFile(join(cuaPackageRoot, REQUEST_ACCESS_CONTRACT_FILE), "utf8"),
    readFile(vendorPath, "utf8"),
  ]);

  if (frameSource.includes("./placeholder/") || !frameSource.includes("./vendor/")) {
    throw new Error(
      `${FRAME_CONTRACT_FILE} is still the placeholder forwarding file while ${VENDOR_ENTRY} ` +
        "exists; refusing to bundle placeholder contracts into the desktop agent",
    );
  }
  assertForwarderExports(requestAccessSource, REQUEST_ACCESS_CONTRACT_SPECIFIER);

  return {
    [FRAME_CONTRACT_SPECIFIER]: {
      contents: extractFrameContract(frameSource, vendorSource),
      source: join(cuaPackageRoot, FRAME_CONTRACT_FILE),
      resolveDir: cuaPackageRoot,
    },
    [REQUEST_ACCESS_CONTRACT_SPECIFIER]: {
      contents: extractRequestAccessContract(vendorSource),
      source: join(cuaPackageRoot, REQUEST_ACCESS_CONTRACT_FILE),
      resolveDir: cuaPackageRoot,
    },
  };
}

const FRAME_INTEGRITY_KEY_PATTERN = /OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "([^"]+)";/;

/**
 * 供 `zcodepro --check` 使用的 dry-run 报告：能否从当前包根派生、真实常量与占位常量是否一致。
 * 只读，不抛错；派生失败通过 reason 返回，让 --check 能继续输出其它检查项。
 */
export async function inspectAgentCuaContracts(cuaPackageRoot) {
  const notDerivable = { derivable: false, constantMatchesPlaceholder: true };
  let overrides;
  try {
    overrides = await loadAgentCuaContractOverrides(cuaPackageRoot);
  } catch (error) {
    return { ...notDerivable, reason: error.message };
  }
  if (!overrides) {
    return { ...notDerivable, reason: `${VENDOR_ENTRY} is missing (overlay not applied)` };
  }
  const frameIntegrityKey = overrides[FRAME_CONTRACT_SPECIFIER].contents.match(
    FRAME_INTEGRITY_KEY_PATTERN,
  )?.[1];
  const placeholderFrameIntegrityKey = await readFrameIntegrityKey(
    join(cuaPackageRoot, "placeholder", FRAME_CONTRACT_FILE),
  );
  return {
    derivable: true,
    frameIntegrityKey,
    placeholderFrameIntegrityKey,
    constantMatchesPlaceholder:
      !frameIntegrityKey ||
      !placeholderFrameIntegrityKey ||
      frameIntegrityKey === placeholderFrameIntegrityKey,
  };
}

async function readFrameIntegrityKey(path) {
  try {
    return (await readFile(path, "utf8")).match(FRAME_INTEGRITY_KEY_PATTERN)?.[1];
  } catch {
    return undefined;
  }
}

export function createAgentCuaContractPlugin(overrides) {
  const missing = AGENT_CUA_CONTRACT_SPECIFIERS.filter((specifier) => !overrides?.[specifier]);
  if (missing.length > 0) {
    throw new Error(`missing agent CUA contract overrides: ${missing.join(", ")}`);
  }
  const byVirtualPath = new Map(
    AGENT_CUA_CONTRACT_SPECIFIERS.map((specifier) => [
      `${AGENT_CUA_NAMESPACE}:${VIRTUAL_PATHS[specifier]}`,
      overrides[specifier],
    ]),
  );
  return {
    name: "zcode-agent-cua-contracts",
    setup(builder) {
      builder.onResolve(
        { filter: /^@zcode\/zcode-cua\/(frame-contract|request-access-contract)$/ },
        (args) => {
          const override = overrides[args.path];
          if (!override) return undefined;
          return {
            path: VIRTUAL_PATHS[args.path],
            namespace: AGENT_CUA_NAMESPACE,
          };
        },
      );
      builder.onLoad({ filter: /.*/, namespace: AGENT_CUA_NAMESPACE }, (args) => {
        const override = byVirtualPath.get(`${AGENT_CUA_NAMESPACE}:${args.path}`);
        if (!override) throw new Error(`unknown agent CUA contract module: ${args.path}`);
        return {
          contents: override.contents,
          loader: "js",
          resolveDir: override.resolveDir,
        };
      });
      builder.onEnd((result) => {
        if (result.errors.length) return;
        const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) =>
          input.replaceAll("\\", "/"),
        );
        const vendorInput = inputs.find((input) => input.includes("zcode-cua/vendor/"));
        if (vendorInput) {
          throw new Error(
            `packages/zcode-cua/vendor entered the agent CJS bundle (${vendorInput}); ` +
              "core/adapters likely added an import of the @zcode/zcode-cua package root, " +
              "broker*, or host-display-contract",
          );
        }
        for (const input of byVirtualPath.keys()) {
          if (!inputs.includes(input)) {
            throw new Error(`agent CJS bundle did not load the derived contract ${input}`);
          }
        }
      });
    },
  };
}
