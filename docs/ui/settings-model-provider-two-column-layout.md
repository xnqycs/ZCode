# 设置页模型供应商双栏布局

`ModelProviderSection` 使用左导航 + 右详情的双栏结构，统一由设置页右侧页面纵向滚动。

## 内容

- 左侧只展示自定义模型供应商；Coding Plan、Team Plan、Start Plan 与内置 Z.ai/BigModel family 入口已移除。
- 左侧空列表时隐藏分组标题；右侧在无供应商时显示空态，引导使用页头「添加供应商」。
- 右侧自定义供应商沿用 endpoint、API Key、模型列表和连通性测试；保存/删除/排序行为不变。
- 双列 CSS Grid 最小高度 36rem，按较高一列自然撑高；导航与详情随外层 main 滚动，不建立额外滚动容器。
- 外层使用 `IPlatformService` 与 settings 导航；不新增 plan target 或购买目标。

## 状态

- `selectedNodeKey` 只表示自定义供应商节点。
- 外部 model-provider target 命中已删除的 plan provider 时显示 navigation unavailable，不进入隐藏详情。
- 新增/删除/排序后沿用现有 `useModelProviders` 与 Optimistic reorder 契约。

## 验证

- 无 provider 时显示空态；添加 provider 后可选中、保存、测试。
- 拖拽排序仍写入 display order。
- 旧 plan target 不导致永久 loading。
