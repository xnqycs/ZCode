import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Plugin } from "esbuild";

export const ZCODE_CUA_PACKAGE_NAME = "@zcode/zcode-cua";
export const ZCODEPRO_OVERLAY_MARKER = ".zcodepro-overlay.json";
export const REMOTE_CUA_PLACEHOLDER_DIR = "placeholder";

const CUA_IMPORT_FILTER = /^@zcode\/zcode-cua(?:\/.*)?$/;

interface CuaPackageManifest {
  exports?: Record<string, { import?: unknown }>;
}

export interface RemoteCuaStub {
  readonly entries: ReadonlyMap<string, string>;
}

/**
 * 每个 CUA 子路径在 placeholder/ 下都有同名实现（叠加时只覆盖包根文件，不动这个目录）。
 * 映射直接来自当前 package.json 的 exports：新增导出但没保留占位实现时，构建立即失败，
 * 不会悄悄把真实 vendor 打回 remote bundle。
 */
export function resolveRemoteCuaStubEntries(packageRoot: string): ReadonlyMap<string, string> {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as CuaPackageManifest;
  const entries = new Map<string, string>();
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const specifier =
      subpath === "."
        ? ZCODE_CUA_PACKAGE_NAME
        : `${ZCODE_CUA_PACKAGE_NAME}/${subpath.replace(/^\.\//, "")}`;
    if (typeof target?.import !== "string") {
      throw new Error(`remote CUA stub: ${specifier} has no import entry in package.json`);
    }
    const stubPath = join(packageRoot, REMOTE_CUA_PLACEHOLDER_DIR, basename(target.import));
    if (!existsSync(stubPath)) {
      throw new Error(
        `remote CUA stub: missing placeholder implementation for ${specifier}: ${stubPath}`,
      );
    }
    entries.set(specifier, stubPath);
  }
  if (!entries.has(ZCODE_CUA_PACKAGE_NAME)) {
    throw new Error(`remote CUA stub: package.json does not export ${ZCODE_CUA_PACKAGE_NAME}`);
  }
  return entries;
}

/**
 * remote 部署只上传单个 zcode-server.cjs，远端工作区也按设计不支持 Computer Use。
 * 叠加后的 producer 会引入含 top-level await 的 vendor，CJS bundle 无法打包；这里只在
 * 检测到 overlay 标记时把 CUA 入口换成保留的占位实现，未叠加的构建保持原路径不变。
 */
export function loadRemoteCuaStub(packageRoot: string): RemoteCuaStub | undefined {
  if (!existsSync(join(packageRoot, ZCODEPRO_OVERLAY_MARKER))) return undefined;
  return { entries: resolveRemoteCuaStubEntries(packageRoot) };
}

export function createRemoteCuaStubPlugin(stub: RemoteCuaStub): Plugin {
  return {
    name: "zcodepro-remote-cua-placeholder",
    setup(build) {
      build.onResolve({ filter: CUA_IMPORT_FILTER }, (args) => {
        const path = stub.entries.get(args.path);
        if (!path) {
          return {
            errors: [
              {
                text:
                  `remote CUA stub does not cover ${args.path}; ` +
                  "Computer Use must stay unavailable in the remote bundle",
              },
            ],
          };
        }
        return { path };
      });
    },
  };
}
