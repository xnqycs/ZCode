import {
  ServiceChannels,
  type ClientConfigReadOptions,
  type ClientConfigSnapshot,
  type DynamicWorkflowClientConfig,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 窗口级公开配置读取。业务模块只消费自己的字段，不拥有第二份请求缓存。 */
export interface IClientConfigService {
  getSnapshot(options?: ClientConfigReadOptions): Promise<ClientConfigSnapshot>;
  /**
   * 动态工作流灰度快照。与公开 client/configs 共用同一个 Host 缓存，
   * 不新增网络请求；用户选择由 Host 在返回前应用到 offer 上。
   */
  getDynamicWorkflowClientConfig(options?: {
    forceRefresh?: boolean;
  }): Promise<DynamicWorkflowClientConfig>;
}

export const IClientConfigService = createServiceDescriptor<IClientConfigService>(
  ServiceChannels.ClientConfig,
);
