import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createUuid } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import type { EnsureDeviceMidOptions } from "./contract.js";

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * 设备身份文件。文件名继续使用 telemetry-state.json，与 Desktop 同步 writer、CLI 和
 * 远端 server 共享同一个 deviceMid；该标识仍用于 X-Device-Mid、feedback 和远控配对。
 */
export interface DeviceState {
  deviceMid?: string;
  /** 保留文件中其他字段，避免三个 writer 互相覆盖。 */
  [key: string]: unknown;
}

interface DeviceLockOwner {
  pid: number;
  createdAt: number;
}

const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

export function resolveDeviceStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

export function resolveDeviceLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

export async function readDeviceState(homeDir?: string): Promise<DeviceState> {
  try {
    const raw = await readFile(resolveDeviceStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as DeviceState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeDeviceState(state: DeviceState, homeDir?: string): Promise<void> {
  const stateFile = resolveDeviceStateFile(homeDir);
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf-8");
}

async function removeStaleLockIfNeeded(lockFile: string, timestamp: number): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readLockOwner(lockFile: string): Promise<DeviceLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DeviceLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

export async function withDeviceStateLock<T>(
  homeDir: string | undefined,
  run: (state: DeviceState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveDeviceLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx");
      try {
        // 旧锁文件只有一个空文件，崩溃后 5 分钟内无法判断是否为孤儿锁。
        // 新锁写入 owner pid，让后续进程能安全回收“刚残留但持有进程已退出”的锁。
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
        const state = await readDeviceState(homeDir);
        return await run(state);
      } finally {
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      // 崩溃/强退后锁文件可能遗留在磁盘上，后续所有启动都会直接卡死到超时。
      // 按 mtime 识别明显过期的孤儿锁并自动回收，避免一个陈旧空文件把设备身份锁死。
      const removedStaleLock = await removeStaleLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, LOCK_RETRY_DELAY_MS);
      await promise;
    }
  }

  throw new Error("Device state lock timeout");
}

/** 调用方必须已持有 state lock；只在 state 缺失 deviceMid 时生成并写回。 */
async function ensureDeviceMidInLockedState(
  state: DeviceState,
  options: EnsureDeviceMidOptions,
): Promise<string> {
  const stateFile = resolveDeviceStateFile(options.homeDir);
  if (state.deviceMid) {
    deviceMidCacheByStateFile.set(stateFile, Promise.resolve(state.deviceMid));
    return state.deviceMid;
  }

  // deviceMid 表达稳定的设备标识，不复用某次上报的 eventId；Desktop 同步 reader、
  // CLI 和远端 server 读取同一个字段，升级后保持同值。
  const deviceMid = (options.randomUUID ?? createUuid)();
  state.deviceMid = deviceMid;
  await writeDeviceState(state, options.homeDir);
  deviceMidCacheByStateFile.set(stateFile, Promise.resolve(deviceMid));
  return deviceMid;
}

/**
 * 确保设备身份文件里存在 deviceMid 并返回它。
 *
 * 远端 zcode-server 所在主机没有 Desktop main 进程；buildZCodeSourceHeaders() 只读不生成，
 * 缺少 X-Device-Mid 会让 billing/balance 被服务端拒绝。这里让远端 server 启动时与
 * Desktop、CLI 共用同一文件、字段和锁，生成并复用同一个设备身份。
 */
export function ensureDeviceMid(options: EnsureDeviceMidOptions = {}): Promise<string> {
  const stateFile = resolveDeviceStateFile(options.homeDir);
  const cached = deviceMidCacheByStateFile.get(stateFile);
  if (cached) {
    return cached;
  }

  // 高频上报过去每条都抢文件锁，即使 deviceMid 已落盘也会打满锁等待。
  // 这里按 state 文件缓存读取 promise，只在首次缺失或首次读取时进入文件锁。
  const pending = withDeviceStateLock(options.homeDir, async (state) =>
    ensureDeviceMidInLockedState(state, options),
  ).catch((error) => {
    if (deviceMidCacheByStateFile.get(stateFile) === pending) {
      deviceMidCacheByStateFile.delete(stateFile);
    }
    throw error;
  });
  deviceMidCacheByStateFile.set(stateFile, pending);
  return pending;
}
