import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { transform } from "esbuild";

// 叠加 ZcodePro 后，`@zcode/zcode-cua` 的包根转发到 `vendor/dist-index.js`。这个文件不是
// 单纯的 CUA 库：它是官方 node-repl-host server bundle 的提取物（ZcodePro README 记录了
// 来源），所以开头带着宿主 bundle 的 createRequire banner，末尾还保留官方自己的两段顶层
// 入口守卫。esbuild 把它内联进本包的 server bundle 后会得到：
//   1. 两条 `__zcodeCreateRequire` import（banner + vendor），ESM 直接语法错误；
//   2. 两份 `isDirectMcpEntrypoint` 主入口守卫 → 同一进程起两个 MCP server 抢同一份 stdio；
//   3. 两份 `isWorkerCallData` 工作线程守卫 → 每个 worker 把用户代码执行两次。
// 实测（只删重复 import 后）一次 `js` 调用产生 2 条响应、用户代码执行 4 次。
//
// 因此构建期在内存里剥掉 vendor 自带的宿主外壳，只保留 CUA 运行时库代码。磁盘上的 vendor
// 文件与 git 历史都不改；未叠加（vendor 不存在）时构建路径与产物完全不变。
const VENDOR_RELATIVE_PATH = "vendor/dist-index.js";
const STRUCTURE_HINT =
  "vendor/dist-index.js 的结构变了（不再是已知的官方 node-repl-host server bundle 提取物），" +
  "需要重新审视内联策略；不要放宽这里的匹配来让构建通过。";

const BANNER_IMPORT =
  'import { createRequire as __zcodeCreateRequire } from "node:module";';
const BANNER_REQUIRE = "const require = __zcodeCreateRequire(import.meta.url);";
const WORKER_ENTRY_ANCHOR = "if (!isMainThread && isWorkerCallData(workerData)) {";
const MAIN_ENTRY_ANCHOR =
  "if (isMainThread && await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {";

const countOccurrences = (haystack, needle) => {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

const fail = (message) => {
  throw new Error(`[node-repl-host] vendor 内联变换失败：${message}\n${STRUCTURE_HINT}`);
};

const lineNumberAt = (source, index) => source.slice(0, index).split("\n").length;

const expectExactlyOnce = (source, needle, label) => {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    fail(`${label} 应恰好命中 1 次，实际 ${count} 次`);
  }
};

// 只处理被移除块里实际出现的词法元素（引号字符串、模板字符串、注释）。正则字面量不扫描：
// 官方这两段入口块里没有正则；如果 vendor 结构变化到块内出现正则，精确锚点或后续断言会
// 先失败，而不是悄悄产生错误切片。
const skipQuotedString = (source, index, label) => {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === quote) return cursor + 1;
    if (char === "\n") break;
    cursor += 1;
  }
  fail(`${label} 第 ${lineNumberAt(source, index)} 行有未闭合的字符串，无法配平括号`);
};

const skipTemplateLiteral = (source, index, label) => {
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "`") return cursor + 1;
    if (char === "$" && source[cursor + 1] === "{") {
      cursor = findMatchingBrace(source, cursor + 1, label) + 1;
      continue;
    }
    cursor += 1;
  }
  fail(`${label} 第 ${lineNumberAt(source, index)} 行有未闭合的模板字符串，无法配平括号`);
};

function findMatchingBrace(source, openIndex, label) {
  if (source[openIndex] !== "{") {
    fail(`${label} 的锚点没有以左花括号结尾（第 ${lineNumberAt(source, openIndex)} 行）`);
  }
  let depth = 0;
  let cursor = openIndex;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '"' || char === "'") {
      cursor = skipQuotedString(source, cursor, label);
      continue;
    }
    if (char === "`") {
      cursor = skipTemplateLiteral(source, cursor, label);
      continue;
    }
    if (char === "/" && source[cursor + 1] === "/") {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end === -1) {
        fail(`${label} 第 ${lineNumberAt(source, cursor)} 行有未闭合的块注释，无法配平括号`);
      }
      cursor = end + 2;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return cursor;
      if (depth < 0) break;
    }
    cursor += 1;
  }
  fail(`${label} 的括号不配平（从第 ${lineNumberAt(source, openIndex)} 行开始）`);
}

const removeEntryBlock = (source, anchor, label) => {
  expectExactlyOnce(source, anchor, label);
  const start = source.indexOf(anchor);
  const closeBrace = findMatchingBrace(source, start + anchor.length - 1, label);
  let end = closeBrace + 1;
  if (source[end] === "\n") end += 1;
  return source.slice(0, start) + source.slice(end);
};

/**
 * 把官方 node-repl-host server bundle 提取物收敛成纯 CUA 运行时库。
 * 每个锚点都必须恰好命中一次；结构漂移时直接失败，不做模糊匹配。
 */
export async function transformVendorForEmbedding(source) {
  const normalized = source.replaceAll("\r\n", "\n");
  expectExactlyOnce(normalized, BANNER_IMPORT, "vendor banner 的 createRequire import");
  expectExactlyOnce(normalized, BANNER_REQUIRE, "vendor banner 的 const require 声明");

  const banner = `${BANNER_IMPORT}\n${BANNER_REQUIRE}`;
  if (!normalized.startsWith(`${banner}\n`)) {
    fail("vendor banner 不在文件开头（createRequire import 与 const require 必须相邻且位于首行）");
  }

  // 宿主的 banner 已经提供同名的 `const require = createRequire(import.meta.url)`，
  // vendor 里对 `require` 的引用会落在这个绑定上，语义完全一致。
  let transformed = normalized.slice(banner.length + 1);
  transformed = removeEntryBlock(transformed, WORKER_ENTRY_ANCHOR, "工作线程入口块");
  transformed = removeEntryBlock(transformed, MAIN_ENTRY_ANCHOR, "主入口块");

  if (transformed.includes("isDirectMcpEntrypoint(import.meta.url")) {
    fail("变换后仍存在 isDirectMcpEntrypoint(import.meta.url) 顶层守卫调用");
  }
  if (transformed.includes(WORKER_ENTRY_ANCHOR)) {
    fail("变换后仍存在工作线程入口守卫");
  }
  if (countOccurrences(transformed, MAIN_ENTRY_ANCHOR) !== 0) {
    fail("变换后仍存在主入口守卫");
  }
  await assertNoTopLevelAwait(transformed);

  return transformed;
}

// 用 esbuild 自己的解析器判断 top-level await：设置 supported["top-level-await"]=false 后，
// esbuild 会在 ESM 输入里保留并校验该语法，遇到顶层 await 直接报错。比手写词法扫描可靠
// （vendor 里存在 `/['"]/` 这类含引号的正则字面量，手写扫描会误判字符串边界）。
const assertNoTopLevelAwait = async (source) => {
  try {
    await transform(source, {
      format: "esm",
      loader: "js",
      supported: { "top-level-await": false },
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && Array.isArray(error.errors)
        ? error.errors.map((entry) => entry.text).join("; ")
        : String(error);
    fail(
      `变换后无法通过 ESM 解析（vendor 里可能新增了会在内联后重复生效的顶层副作用）：${detail}`,
    );
  }
};

/**
 * 未叠加时 vendor 不存在，返回 undefined，构建路径与产物保持原样。
 */
export function loadVendorEmbedTransform(cuaPackageRoot) {
  const vendorPath = resolve(cuaPackageRoot, VENDOR_RELATIVE_PATH);
  if (!existsSync(vendorPath)) return undefined;
  return { vendorPath };
}

const expectCount = (bundle, needle, expected, label) => {
  const actual = countOccurrences(bundle, needle);
  if (actual !== expected) {
    throw new Error(
      `[node-repl-host] 内联 vendor 后的产物中 ${label} 应为 ${expected} 处，实际 ${actual} 处；` +
        "vendor 的入口代码可能没有被完全剥离。",
    );
  }
};

/**
 * 产物体检：只允许 fork 自己的一套入口逻辑存在。
 */
export function assertBundledHostInvariants(bundle) {
  expectCount(
    bundle,
    'import { createRequire as __zcodeCreateRequire } from "node:module";',
    1,
    "createRequire banner import",
  );
  expectCount(bundle, "isDirectMcpEntrypoint(import.meta.url", 1, "主入口守卫调用");
  expectCount(bundle, "new Worker(", 1, "Worker 构造");
  expectCount(bundle, '"zcode-node-repl-call"', 1, "node_repl worker kind 字面量");
  for (const duplicate of ["isDirectMcpEntrypoint2", "WORKER_KIND2", "Worker2"]) {
    if (bundle.includes(duplicate)) {
      throw new Error(
        `[node-repl-host] 内联 vendor 后的产物仍包含重复标识 ${duplicate}；` +
          "vendor 的宿主外壳没有被完全剥离。",
      );
    }
  }
}

/**
 * esbuild 插件：只对叠加后的那一个绝对路径做内存变换，其它模块一律不拦截。
 */
export function createVendorEmbedPlugin({ vendorPath, outfile }) {
  const absoluteVendorPath = resolve(vendorPath);
  return {
    name: "zcode-vendor-embed",
    setup(build) {
      build.onLoad({ filter: /.*/ }, async (args) => {
        if (resolve(args.path) !== absoluteVendorPath) return undefined;
        const source = await readFile(args.path, "utf8");
        return {
          contents: await transformVendorForEmbedding(source),
          loader: "js",
          resolveDir: dirname(absoluteVendorPath),
        };
      });
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;
        const bundle = await readFile(outfile, "utf8");
        assertBundledHostInvariants(bundle);
      });
    },
  };
}
