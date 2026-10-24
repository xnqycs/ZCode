import type { ServicesDeviceContract } from "./contract.js";
import { ensureDeviceMid } from "./deviceMid.js";

export const servicesDevice: ServicesDeviceContract = { ensureDeviceMid };

export { ensureDeviceMid } from "./deviceMid.js";
export type { EnsureDeviceMidOptions, ServicesDeviceContract } from "./contract.js";
