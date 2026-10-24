# services-device

意图：为 Desktop、CLI 和远端 server 提供同一个稳定设备身份，供 `X-Device-Mid`、feedback、
远控配对和自动更新使用。它不是遥测通道，也不产生任何网络请求。

不变量：

- 磁盘文件固定为 `telemetry-state.json`，字段固定为 `deviceMid`；文件名是历史兼容，不代表上报。
- 三个 writer（services 异步、Desktop 同步、CLI）共用同一路径、字段与
  `telemetry-state.lock` 协议。
- 已有合法 `deviceMid` 时不写盘；缺失时才生成并原子写回，保留文件中的其他字段。
- 文件损坏或写盘失败不阻断窗口创建、模型请求或远端 server 启动。
- 生成结果在同一进程内按 state 文件缓存；并发调用不会产生两个设备身份。
