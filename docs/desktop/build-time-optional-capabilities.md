# 桌面构建期可选能力

## 目标

自动更新由构建期配置决定是否启用，未配置时关闭：

| 能力 | 配置项 | 关闭时的行为 |
| --- | --- | --- |
| 自动更新 | `ZCODE_AUTO_UPDATE`（`1`、`true`、`yes` 为启用） | 与 Preview 形态相同，不检查、不下载更新 |

这样同一份源码可以产出“默认不自动更新”的构建，也可以产出启用自动更新的正式构建，
不需要在源码里写死开关。

## 配置来源与优先级

1. 构建进程的环境变量。显式设置为空字符串表示关闭。
2. `config/private/build-defaults.json`。只存在于内部仓库，开源导出不包含。
3. 以上都没有时关闭。

## 所有者与数据流

```
环境变量 / config/private/build-defaults.json
        │ scripts/build-time-config.mjs（唯一解析入口）
        ▼
desktop tsup（main、host、preload）与 desktop vite（renderer）的 define
        │ __ZCODE_AUTO_UPDATE_ENABLED__
        ▼
@zcode/shared env 常量 ── 运行时代码只读该常量
```

- 未注入 define 的环境（测试、其他 bundle）得到关闭值。
- 自动更新在 Desktop Main 启动时判定：`ZCODE_PRODUCT_FLAVOR === "production" && ZCODE_AUTO_UPDATE_ENABLED`。

## 验收

1. 内部仓库存在私有默认配置时，构建结果与改造前一致：自动更新启用。
2. 没有私有默认配置、也没有环境变量时关闭。
3. 环境变量优先于私有默认配置，显式空字符串可以关闭。
4. 类型检查、Lint 与相关单测通过。
