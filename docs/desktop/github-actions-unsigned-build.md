# GitHub Actions 未签名桌面构建

- 状态：已实施
- 范围：公开仓库的 PR 质量门禁与六平台桌面安装包构建
- 不包含：Windows/macOS 代码签名、公证、OSS/CDN 上传、正式更新 feed、桌面 E2E

## 目标

在没有 Windows 和 macOS 代码签名证书的前提下，仍然能够：

- 在 PR / main push 上执行类型检查、Lint、数据库 schema、架构检查和受影响单测。
- 手动构建 Linux x64/arm64、Windows x64/arm64、macOS x64/arm64 的未签名桌面安装包。
- 把六个平台的产物作为 GitHub Actions artifact 或 GitHub prerelease 提供测试者下载。
- 保持正式签名发布链路不受影响；签名、公证和 OSS/CDN 发布仍由具备凭据的流程负责。

## 工作流

| 文件                                          | 触发                | 职责                                                                                      |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`                    | PR、main push、手动 | Node 24 / pnpm 10.33.2 安装，`typecheck`、`lint`、`db:schema:check`、架构检查、受影响单测 |
| `.github/workflows/build-desktop.yml`         | 手动                | 六平台未签名安装包；默认创建 GitHub prerelease，可取消                                    |
| `.github/workflows/build-desktop-zcodepro.yml` | 手动                | 叠加 ZcodePro Computer Use 运行时，只构建 Windows x64 未签名包；产物仅 artifact            |
| `.github/actions/setup/action.yml`            | 被上述工作流复用    | 安装 `mise.toml` 固定的 Node 24.14.0、`packageManager` 指定的 pnpm，并执行冻结锁文件安装  |
| `.github/scripts/build-linux-in-container.sh` | Linux matrix job    | 在 `rockylinux:8` 中安装 Node 24/pnpm、构建 Linux 包                                      |

## 平台矩阵

| 平台            | Runner             | 构建环境                                      |
| --------------- | ------------------ | --------------------------------------------- |
| `linux-x64`     | `ubuntu-24.04`     | `rockylinux:8` 容器，glibc 2.28               |
| `linux-arm64`   | `ubuntu-24.04-arm` | `rockylinux:8` 容器，glibc 2.28               |
| `windows-x64`   | `windows-2022`     | 原生 x64                                      |
| `windows-arm64` | `windows-2022`     | x64 交叉构建 arm64；镜像包含 `VC.Tools.ARM64` |
| `macos-x64`     | `macos-15-intel`   | 原生 Intel                                    |
| `macos-arm64`   | `macos-14`         | 原生 Apple Silicon；7 GB RAM 是已知风险       |

Linux 不使用 `ubuntu-24.04` 的 glibc 2.39 直接构建。仓库的 Linux 运行时下限是 glibc 2.28（node-pty、bfs、ugrep 预编译产物），在较新的 glibc 上安装或重编译原生依赖会把产物下限抬高。容器内额外使用 GCC 12 toolset 和 Python 3.11：Rocky 8 默认的 GCC 8 / Python 3.6 无法编译 node-pty 的 C++20 源码和 node-gyp 11 的 gyp 生成器。

## 构建命令

每个平台 job 都从干净 checkout 执行：

```bash
pnpm install --frozen-lockfile
pnpm build:bootstrap
pnpm prepare:desktop-runtime
pnpm bundle:desktop -- --os <mac|win|linux> --arch <x64|arm64> --skip-build --skip-prepare
```

- `build:bootstrap` 构建除 desktop 外的 workspace 包，然后执行 desktop 的平台无关 `out/` 构建。
- `prepare:desktop-runtime` 准备当前平台的 agent bundle、native search 工具和 `bundled-agents`/`bundled-tools`。
- `bundle:desktop` 只执行 electron-builder、运行时依赖校验和安装包体积审计；`--skip-build --skip-prepare` 避免重复构建。
- Linux 的完整命令由 `.github/scripts/build-linux-in-container.sh` 在容器内执行。

## ZcodePro 叠加构建

`build-desktop-zcodepro.yml` 只构建 `windows-x64`，并在构建前把 `xnqycs/ZcodePro` 的检出叠加到
`packages/zcode-cua`。输入 `zcodepro_ref` 固定为完整 40 位 commit sha（默认
`779bf8816adbad495be69f6b1d38409bad8c0554`），工作流会拒绝分支名等非 sha 输入。

安装顺序与官方构建不同：

1. checkout 本仓库；
2. 用 `actions/checkout@v4` 把 ZcodePro 检出到工作区内的 `zcodepro-runtime`。`actions/checkout`
   不接受 `GITHUB_WORKSPACE` 之外的 `path`，所以不能写到 `../ZcodePro`；该目录不在 pnpm
   workspace glob 内，也不会被 desktop 的 `files` / `extraResources` 收集；
3. `./.github/actions/setup` 使用 `install: "false"`，只安装 Node 24.14.0 与 pnpm；
4. 运行 overlay。叠加会给 `@zcode/zcode-cua` 增加 `sharp` / `express` 依赖；
5. 运行 `pnpm install --no-frozen-lockfile`。此时 `pnpm-lock.yaml` 与 `package.json` 必然不一致，
   冻结安装会失败；`apps/zcode-cli` 的构建入口设置了 `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`，
   不会在子 workspace 触发第二次安装；
6. 依次执行 `build:bootstrap`、`prepare:desktop-runtime`、`bundle:desktop`。

`electron-builder` 的 `afterPack` 会调用 `finalizePackagedWindowsCuaHelper`，校验最终
`resources/tools/cua-helper` 的 manifest、entry/addon 哈希、PE 架构与依赖闭包。工作流再补一条
固定哈希断言：`sha256.entry` / `sha256.addon` 必须分别等于
`def39fc9…26ec` / `0dee894c…274c`。产物只上传 artifact，保留 7 天，不创建 Release。

## 产品身份与自动更新

未签名构建默认使用 Preview 身份，避免覆盖用户已安装的签名版 ZCode：

```text
ZCODE_ENV=production
ZCODE_PREVIEW_IDENTITY=1
```

- `ZCODE_PREVIEW_IDENTITY=1` 得到 `ZCode Preview`、独立 appId 和 `zcode-preview` Linux 包名。
- 手动选择 `product=production` 时使用正式 ZCode 身份，但产物仍然未签名，只适合内部测试。
- `ZCODE_AUTO_UPDATE=0` 显式关闭自动更新。未签名 macOS 应用不能被 Squirrel.Mac 自动更新；未签名 Windows 安装包也会持续触发 SmartScreen。
- 自动更新的唯一合法开关仍然是 `ZCODE_AUTO_UPDATE`，不要在未签名构建中启用。

## 产物

- Workflow artifact：`zcode-<product>-<platform>`，保留 7 天。
- 默认创建 GitHub prerelease：`unsigned-<run_number>`，包含 `SHA256SUMS.txt` 和 `UNSIGNED.txt` 警告；可在手动触发时取消 `publish_release`。
- 不生成或上传 stable update feed；`latest*.yml` 不进入 artifact，避免被误当作可发布更新元数据。
- 安装包仍受 `packages/desktop/scripts/audit-bundle-size.mjs` 的 500 MiB 上限约束。

## 未签名构建的限制

- macOS：Gatekeeper 拦截下载后的应用；需要“系统设置 → 隐私与安全性 → 仍要打开”，或手动移除 quarantine。Squirrel.Mac 自动更新不可用。
- Windows：SmartScreen 提示未知发布者；企业策略或 Defender 可能直接阻止。生产分发需要 EV 证书或云端签名（如 Azure Trusted Signing），普通 OV 证书自 2023 年 6 月起不再消除警告。
- Linux：不受代码签名影响。

## 已知基线

全量 `pnpm test:unit` 目前在 `main` 上仍有 telemetry 移除后的遗留断言失败（运行于 Node 24 的本地验证：27 个测试文件、174 个用例失败）。这些失败与本工作流无关，因此 `ci.yml` 暂用 `test:unit:affected --base` 作为阻塞门禁；修复全量套件后再切回 `pnpm test:unit`。

## 后续启用签名

签名步骤应作为可选 job 加入，而不是改写构建矩阵：

1. macOS 导入 Developer ID p12 到临时 keychain，`electron-builder` 签 `.app`，再对 DMG 执行 `codesign`、`notarytool`、`stapler`，最后用 `scripts/doctor-macos-release-app.sh` 验收。
2. Windows 使用 `CSC_LINK` / `CSC_KEY_PASSWORD`，或恢复 `scripts/sign-windows.ps1` 后重新启用 `ZCODE_ENABLE_WINDOWS_SIGN=1`。
3. 签名与发布凭据只放在受保护的 GitHub Environment，仅 tag 或手动 release 触发；fork PR 不接触凭据。
4. 发布仍走现有 OSS/CDN/后端 release API 链路；GitHub Release 不能替代客户端 updater。

## 验收

- PR 工作流在干净 checkout 上通过 `pnpm typecheck`、`pnpm lint`、`pnpm db:schema:check`、`pnpm test:architecture`、`pnpm architecture:check -- --changed`、`pnpm test:unit:affected --base <base>`。
- `workflow_dispatch` 运行时六个平台 job 全部成功，并产出对应安装包 artifact。
- 默认 `publish_release=true`；生成的 prerelease 带 `UNSIGNED.txt` 与 `SHA256SUMS.txt`。
- 未签名产物不得进入正式更新 feed；不得设置 `ZCODE_AUTO_UPDATE=1`。
