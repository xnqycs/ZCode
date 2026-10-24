/**
 * services-device 对外契约：设备身份的唯一生成与读取入口。
 *
 * 该模块只负责 deviceMid；不负责遥测、日志或账号状态。
 */
export interface EnsureDeviceMidOptions {
  /** 覆盖数据根目录；默认使用 getAppConfigDir()。 */
  homeDir?: string;
  /** 仅测试注入的 UUID 生成器。 */
  randomUUID?: () => string;
}

export interface ServicesDeviceContract {
  /**
   * 确保设备身份文件中存在 deviceMid 并返回。
   *
   * 前置：无。
   * 后置：文件已有合法 deviceMid 时只读不写；缺失时原子写回后再返回。
   * 幂等：同一进程内并发调用共享同一次读取/生成。
   */
  ensureDeviceMid(options?: EnsureDeviceMidOptions): Promise<string>;
}
