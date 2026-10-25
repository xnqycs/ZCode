# ZcodePro Computer Use 运行时叠加（构建时）

## 背景

开源仓库的 `packages/zcode-cua` 是占位包（`package.json` 声明 `zcodeCuaPlaceholder: true`），
所有 Computer Use 能力 fail-closed。真实运行时（broker、Helper、PiP、原生 `ax_native.node`）
只存在于闭源发行物，由 [`xnqycs/ZcodePro`](https://github.com/xnqycs/ZcodePro) 以提取产物的形式维护，
基线提交 `779bf88`。

这些产物不能进入本仓库的 git 历史（闭源、体积大、含平台二进制）。因此采用**构建时叠加**：
在本地检出 ZcodePro 后用脚本把它覆盖到 `packages/zcode-cua`，构建完成可一键还原。
本机制不改变 [producer 检测](computer-use-producer-detection.md) 的判定语义：
叠加后 `readComputerUseProducer` 自然看到真实 producer，还原后回到占位包。

## 范围

**支持**：目标平台 `win32-x64`。

**不支持**：macOS、Linux、Windows arm64。ZcodePro 的 `ax_native.node` 只有 x64 版本，macOS Helper 需从官方 CDN 拉取。
脚本在目标平台不匹配时**直接拒绝**，不做静默跳过。

**不做**：不修改 `computer-use-producer.mjs`；不为占位包添加绕过 fail-closed 的分支；
不使用 ZcodePro 的 `install.ps1` / `install.sh` / `tools/patch-cua-runtime.cjs`（它们面向已安装的闭源包改 `app.asar`）。

## 输入

| 方式               | 说明                  |
| ------------------ | --------------------- |
| `--zcodepro <dir>` | ZcodePro 本地检出目录 |
| `ZCODEPRO_DIR`     | 同上，命令行优先      |

脚本内部不做任何本机路径假设。克隆地址：`git@github.com:xnqycs/ZcodePro.git`（HTTPS 等价），基线 `779bf88`。
其它 fork（含上游 `luxi233/ZcodePro`）的运行时版本为 0.6.4 / 文档插件 0.1.8，会被版本校验拒绝。

## 目标平台语义

判定的是**构建目标**，不是宿主系统。取值来自 `ZCODE_TARGET_OS` / `ZCODE_TARGET_ARCH`，
语义复用 `packages/desktop/scripts/target-platform.mjs` 的 `getTargetPlatform(env)`（未显式提供时回退宿主
`process.platform` / `process.arch`）。脚本本身在 Windows、Linux、macOS 宿主上都可运行与测试，
路径一律使用 `node:path`，只调用 `git` 与 Node 标准库，不依赖 Windows 专有命令。

不匹配时报错并提示：

```text
unsupported target platform <key>: ZcodePro overlay only supports win32-x64.
Set ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64.
```

## 命令

```bash
# 应用（默认动作）
node scripts/zcodepro/apply-zcodepro.mjs --zcodepro /path/to/ZcodePro
# 或
pnpm zcodepro:apply -- --zcodepro /path/to/ZcodePro

# 只校验，不改动工作区
pnpm zcodepro:check

# 还原
pnpm zcodepro:revert
```

在 Linux 服务器上验证时同样要显式给目标平台：

```bash
ZCODE_TARGET_OS=win32 ZCODE_TARGET_ARCH=x64 pnpm zcodepro:apply -- --zcodepro /www/Projects/ZcodePro
```

## `apply` 行为

### 1. 前置校验（任一失败即中止，不写文件）

1. 目标平台必须是 `win32-x64`。
2. ZcodePro 目录存在且包含：
   - `runtimes/zcode-cua/package.json`，`name === "@zcode/zcode-cua"`；
   - `runtimes/cua-helper/runtime-manifest.json`；
   - `runtimes/cua-helper/dist/windows-helper.js`；
   - `runtimes/cua-helper/build/Release/ax_native.node`。
3. `runtimes/zcode-cua` 与 `runtimes/cua-helper` 的版本号一致且 `>= 0.6.5`。低于该版本提示使用
   `xnqycs/ZcodePro`。
4. 两个产物的 sha256 与 `runtime-manifest.json` 记录一致：
   - 文本文件（`windows-helper.js`）先把 `\r\n` 归一为 `\n` 再计算；
   - 二进制（`ax_native.node`）按原始字节计算；
   - 不因为行尾差异判定损坏，也不修改 manifest 去迁就输入。
5. `ax_native.node` 的 PE machine 为 `0x8664`。
6. Helper 的 `node_modules` 中 `sharp` / `express` 的实际版本分别为 `0.34.5` / `5.2.1`；
   版本不一致时中止（避免运行时依赖与发布契约静默漂移，需要人工确认后更新本 spec 与脚本常量）。
7. `packages/zcode-cua` 只存在标记文件缺失或已被覆盖的状态：若没有标记文件但该目录有本地改动，中止并提示
   先提交/暂存或 `--revert`，避免覆盖用户改动。

### 2. 写入 `packages/zcode-cua`

- 从 `runtimes/zcode-cua` 复制 `*.js`、`*.d.ts`、`vendor/`；从 `runtimes/cua-helper` 复制 `dist/`、`build/`
  （**不复制 `node_modules/`**，依赖交给 pnpm 安装）。全部**复制**，不建符号链接：Windows runtime 要求
  producer 根是物理目录，symlink/junction 会被拒绝。
- **保留不动**：`tsconfig.json`、`vitest.config.ts`、`placeholder/`。包根 `*.js` 只做
  `export * from "./placeholder/....js"` 转发，叠加只覆盖包根，`placeholder/` 始终是占位实现
  （remote bundle 依赖它，见下文）。
- 文本文件（`.js`、`.mjs`、`.cjs`、`.d.ts`、`.ts`、`.json`、`.md`）统一写成 LF；`.node` 等二进制按原始字节复制。
  原因见“行尾”一节。
- 合成 `package.json`：以 ZcodePro 的清单为底，移除 `zcodeCuaPlaceholder`，保留 fork 的
  `scripts.build`（`tsc --noEmit -p tsconfig.json`，根 `prepare` 依赖它），并加入：

  ```json
  "zcodeCuaRuntime": {
    "schema": 1,
    "windows": { "entry": "dist/windows-helper.js", "nativeAddon": "build/Release/ax_native.node" }
  },
  "dependencies": { "sharp": "0.34.5", "express": "5.2.1" }
  ```

  `zcodeCuaRuntime` 的键集合必须恰好是 `{schema, windows}` / `{entry, nativeAddon}`，否则
  `prepareWindowsCuaHelperAssets` 会拒绝。`sharp` 声明还会让 `isSharpRequiredByComputerUse` 返回 true。

- 向 `broker-server.d.ts` 追加 3 行声明（幂等，已存在则跳过）。ZcodePro 的运行时 JS 导出了它们，
  但 `.d.ts` 漏写；fork 的 `cuaStandaloneStatusLaunch.ts` 需要：

  ```ts
  export declare function resolveHelperAppName(env?: NodeJS.ProcessEnv): string;
  export declare function resolveCuaHelperInstallRoot(env: NodeJS.ProcessEnv): string | null;
  export declare function standaloneHelperCandidatePaths(env?: NodeJS.ProcessEnv): string[];
  ```

- 删除 `test/availability.test.ts`（它断言“占位包报告不可用”，叠加后必然失败），写入
  `test/overlay-contract.test.ts`：只断言包形态（无 `zcodeCuaPlaceholder`、`zcodeCuaRuntime` 契约存在且指向的文件存在、
  `exports` 里的 JS 文件都存在、`scripts.build` 存在），**不启动真实 broker / Helper**。

### 3. 标记文件

写入 `packages/zcode-cua/.zcodepro-overlay.json`（已 gitignore），记录：

```json
{
  "schema": 1,
  "zcodepro": { "path": "<绝对路径>", "head": "<git rev-parse HEAD>", "dirty": false },
  "producer": { "version": "0.6.5", "helperVersion": "0.6.5" },
  "target": { "os": "win32", "arch": "x64" },
  "sha256": { "entry": "<归一化后>", "addon": "<原始字节>" },
  "appliedAt": "<ISO 时间>"
}
```

`dirty` 如实记录（ZcodePro 可能是工作目录，未必是干净检出）。

### 4. 清理过期构建产物

叠加会切换 `@zcode/zcode-cua` 的实现，下列**已被 gitignore** 的生成目录会留存旧占位实现：

- `apps/zcode-cli/packages/node-repl-host/dist`
- `apps/zcode-cli/packages/cli/dist`
- `packages/desktop/bundled-agents`
- `packages/desktop/bundled-tools`
- `packages/desktop/out`

当标记与上次不同（首次应用，或 ZcodePro 的 HEAD / producer 版本变化）时删除它们。
删除前用 `git check-ignore` 确认被忽略，绝不动受版本控制的文件。

### 5. 幂等

连续执行两次：第二次逐文件比较目标字节，全部一致且标记未变化时输出“已应用，无变化”，不写任何文件。
部分文件被外部改动时只重写差异文件。

### 6. 结束提示

打印后续必须执行的步骤（不改写用户已有的打包命令）：

```text
Next steps:
  1. pnpm install --no-frozen-lockfile
  2. build the Windows x64 package with your usual preview command
```

## `--check`

不写文件。输出：

- ZcodePro 校验结果（版本、sha256、PE、dirty）；
- 当前是否已叠加（标记 + 目标文件字节比对）；
- agent CJS 构建的契约派生 dry-run：能否派生、真实常量与占位常量是否一致（见下文
  “agent CJS bundle 的契约处理”）；
- 四个文档插件（documents / pdf / presentations / spreadsheets）的版本与 ZcodePro `plugins/<name>-plugin`
  是否一致；不一致**只警告**，不影响退出码。

目标平台或 ZcodePro 校验失败时非零退出。

## `--revert`

1. `git checkout -- packages/zcode-cua pnpm-lock.yaml`（仅作用于已跟踪路径）。
2. 删除叠加产生的未跟踪文件：`vendor/`、`dist/`、`build/`、`.zcodepro-overlay.json`、`test/overlay-contract.test.ts`。
3. 清理上述生成目录。
4. 校验 `git status --porcelain -- packages/zcode-cua pnpm-lock.yaml` 为空。

还原后 `pnpm typecheck` 必须回到占位包的状态。

## remote 单文件 bundle

`packages/server` 的 `build:remote` 输出 `dist/remote/zcode-server.cjs`，供 SSH / WSL / Docker
远程部署使用：部署端只上传这一个文件。远程工作区按设计不支持 Computer Use（见 ZcodePro README
的兼容表）。叠加后的 producer 会通过 `vendor/dist-index.js` 把 broker 运行时内联进来，该文件包含
top-level await：

```js
if (isMainThread && await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {
```

esbuild 的 CJS 输出不支持 top-level await，直接报错。处理方式：

- `packages/zcode-cua/placeholder/` 保存占位实现；包根 `*.js` 只是转发导出，叠加只覆盖包根，
  不会碰这个目录。
- `packages/server/src/buildRemoteCuaStub.ts` 检测 `packages/zcode-cua/.zcodepro-overlay.json`：
  存在时把 `@zcode/zcode-cua` 及全部 subpath 解析到 `placeholder/` 下的同名文件；未叠加时
  返回 `undefined`，构建完全走原来的解析路径。
- 映射直接来自当前 `package.json` 的 `exports`。如果新增导出却没有保留同名占位文件，构建会
  失败并指出缺失项，而不是悄悄把真实 vendor 打回 remote bundle。
- 远程 bundle 的 Computer Use 因此与占位包完全一致：`createComputerUseRuntime` 返回不可用，
  broker 方法抛 `unavailable`，保持 fail-closed。

## agent CJS bundle 的契约处理

桌面 agent 的 `dist/zcode.cjs` 是 CJS 单文件，不能像 remote bundle 那样把两个契约换回占位实现：

1. **占位契约会拒绝每一张 Computer Use 截图。** 占位 `attestOfficialCuaFrameContent` 恒返回
   `undefined`；`apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` 在“官方 CUA 结果含图片
   且 attest 失败”时抛 `Official CUA frame failed final model-content attestation`。CI 不会因此变红，
   只会在真实使用时丢掉所有截图。
2. **`request-access-contract` 也必须覆盖。** 它是对 `vendor/dist-index.js` 的纯转发，agent 的
   `result-display.ts` 直接导入；只处理 `frame-contract` 仍会把 vendor 拉进 CJS 图。
3. **agent 图只用到这两个子路径。** `createComputerUseRuntime`、`broker*`、`pip-session*`、
   `host-display-contract` 只出现在 ESM 的 `node-repl-host` / `packages/services`，ESM 允许
   top-level await。

因此 `apps/zcode-cli/packages/cli/scripts/agent-cua-contracts.mjs` 在**检测到
`vendor/dist-index.js`（即已叠加）时**，为这两个 specifier 提供构建期派生的无 vendor 副本；
未叠加时返回 `undefined`，`build.mjs` 的插件列表与改动前完全一致。派生规则：

- `frame-contract.js`：vendor 引用必须**恰好一次**且整行等于
  `import { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY } from "./vendor/dist-index.js";`；
  从 vendor 用 `var OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "…";` 读取唯一常量并替换该行，
  同时断言 `export { OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY };` 仍存在。其余字节不动。
- `request-access-contract.js`：从 vendor 截取
  `var CUA_REQUEST_ACCESS_STATUS_META_KEY =` 到 `function attachCuaRequestAccessStatusMeta(` 之间的块，
  要求块内只有一个 `external_exportsN` 绑定、顶层声明恰好是常量 / Zod schema / 读取函数三个，
  把绑定换成 `z` 并前置 `import { z } from "zod";`。
- 出现任何偏离（第二个 vendor import、多行 import、常量改名、块内新增依赖）都会让构建失败，
  提示重新审视抽取；不会退回占位契约，也不会写入硬编码副本。

构建结束的 `onEnd` 断言两件事：

1. `metafile.inputs` 里两个虚拟契约模块（`zp-agent-cua:*`）确实被加载；
2. 任何输入路径包含 `zcode-cua/vendor/` 都失败。

所以以后 core/adapters 新增对 `@zcode/zcode-cua` 包根、`broker*` 或 `host-display-contract` 的导入，
会在 agent CJS 构建阶段直接报错，而不是把 top-level await 带进桌面产物。

`pnpm zcodepro:check` 还会对叠加后的包根做一次 dry-run 派生，报告“agent contracts: derivable /
not derivable（原因）”，并在真实 `frame-contract` 的常量与 `placeholder/frame-contract.js` 不一致时
给出警告；该检查只报告，不改变 `--check` 的退出语义。

## 行尾（CRLF）

ZcodePro 的 git blob 是 LF，但仓库没有 `.gitattributes`；Windows 上 `core.autocrlf=true` 时新克隆的文本文件工作区是 CRLF。
已实测 `runtimes/cua-helper/dist/windows-helper.js`：

| 口径                         | sha256                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| 工作区原始字节（CRLF）       | `1a651d3e10964bf004555e3d498f1c2571f9df6b2526643b66407db7c19eb261` |
| 归一为 LF 后                 | `def39fc99aa37f07dc9bffecd2b270243939b518567ca37835d0c2f42ea426ec` |
| `runtime-manifest.json` 记录 | `def39fc99aa37f07dc9bffecd2b270243939b518567ca37835d0c2f42ea426ec` |

`ax_native.node` 是二进制，不受影响（`0dee894c…274c`）。所以：

1. 校验文本哈希前归一为 LF，不判定损坏、不改 manifest；
2. 复制文本文件时统一写 LF，否则 `prepareWindowsCuaHelperAssets` 会对 CRLF 字节重新哈希，
   产物 manifest 与 ZcodePro 记录不一致（自洽但误导排查）；
3. 二进制按原始字节复制。

## 依赖与 lockfile

`sharp` 目前不在 `pnpm-lock.yaml` 中。叠加写入 `dependencies` 后必须执行
`pnpm install --no-frozen-lockfile`；`.npmrc` 是 `node-linker=hoisted`，`pnpm-workspace.yaml` 的
`supportedArchitectures` 已包含 `win32` / `x64`，因此 `@img/sharp-win32-x64` 会被解析。
叠加产生的 `pnpm-lock.yaml` 变更**不得提交**；`--revert` 会一并还原。

## `ZCODE_CUA_DEV_MODE` 在打包态的真实语义

结论（依据本仓库源码与 ZcodePro 0.6.5 运行时）：

- `isZCodeCuaInternalFeatureEnabled`（`packages/shared/src/runtimeEnv.ts`）**默认返回 true**；
  `ZCODE_CUA_DEV_MODE=1/true/on` 只是显式开启，`ZCODE_CUA_PRODUCT_HELPER=0/false/off` 才关闭。
  它管的是 package 侧 CUA 插件装配，不是 Helper 签名校验。
- `isCuaLocalDevelopmentRuntime`（ZcodePro `broker/server`，实现为
  `COMPILED_LOCAL_DEVELOPMENT_RUNTIME && ZCODE_RUNTIME_ENV !== "production"`）才决定“本地未签名 Helper”放宽。
  桌面 host bundle 没有 `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` 折叠，回退为 `NODE_ENV !== "production"`；
  而打包态 Main 显式下发 `ZCODE_RUNTIME_ENV=production` 并清掉继承的 `NODE_ENV`
  （`packages/desktop/src/main/desktopRuntimeEnv.ts:515-532`）。因此**打包后的应用里 `isCuaLocalDevelopmentRuntime`
  为 false，`ZCODE_CUA_DEV_MODE=1` 不会放宽 Helper 签名校验**。
- Windows helper 0.6.5 里 `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN = true`，peer identity 校验暂时整体放行；
  `ZCODE_CUA_DEV_MODE` 只影响 `isUnauthenticatedLocalDevRequested`，而后者仍要求
  `isCuaLocalDevelopmentRuntime`，所以对打包态同样无效。

因此安装包启动后看不到“电脑控制”时，**先查插件启用状态**（`~/.zcode/cli/config.json` 的
`plugins.enabledPlugins["computer-use@zcode-plugins-official"]`），不要把 `ZCODE_CUA_DEV_MODE` 当作发布包开关。
它是本地开发（未打包）的一键开关。以上结论来自源码与运行时 bundle 阅读，未在 Windows 安装包上实测。

## 验证边界

本仓库 CI 只在 `windows-2022` 上构建 Windows 安装包，没有 Linux 交叉打包的先例。Linux/macOS 宿主能验证：
overlay 单测、`pnpm install --no-frozen-lockfile`、`pnpm typecheck` / `lint`、`prepare:windows-cua-helper`
的产物暂存与哈希。安装包构建、安装后启动、设置页开关与真实 Computer Use 调用必须在 Windows 桌面上完成。
