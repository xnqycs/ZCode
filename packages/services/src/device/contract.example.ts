import type { ServicesDeviceContract } from "./contract.js";

/** 最常见调用：读取当前设备的稳定身份。 */
export function exampleServicesDevice(contract: ServicesDeviceContract): Promise<string> {
  return contract.ensureDeviceMid();
}
