import {
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  memoryUsageToSampleFields,
  type MemoryDiagnosticsRegistry,
  type MemorySampleWriteGate,
} from "@zcode/shared";

/**
 * main 进程内存诊断计数器注册表。
 * `index.ts` 在实例化 TaskRealtimeBus / BroadcastHub / BrowserGuestManager 后注册 provider；
 * `startMainMemoryDiagnosticsLog` 每 60 秒 collect 一次写主日志。
 */
export const mainMemoryDiagnosticsRegistry: MemoryDiagnosticsRegistry =
  createMemoryDiagnosticsRegistry();

const MEMORY_LOG_INTERVAL_MS = 60_000;

let memoryLogTimer: ReturnType<typeof setInterval> | null = null;
let memorySampleWriteGate: MemorySampleWriteGate = createMemorySampleWriteGate();

/** 只写本地 `[memory]` 诊断日志；不发送任何远端数据。 */
export function startMainMemoryDiagnosticsLog(logger: {
  info: (...args: unknown[]) => void;
}): void {
  stopMainMemoryDiagnosticsLog();
  memorySampleWriteGate = createMemorySampleWriteGate();
  memoryLogTimer = setInterval(() => {
    try {
      const sample = {
        role: "main" as const,
        ...memoryUsageToSampleFields(process.memoryUsage()),
        counters: mainMemoryDiagnosticsRegistry.collect(),
      };
      const reason = memorySampleWriteGate.evaluate(sample, Date.now());
      if (reason) {
        logger.info(formatMemorySampleLine(sample, reason));
      }
    } catch {
      // 诊断日志失败只丢当前样本，不影响主进程。
    }
  }, MEMORY_LOG_INTERVAL_MS);
  memoryLogTimer.unref?.();
}

export function stopMainMemoryDiagnosticsLog(): void {
  if (memoryLogTimer) {
    clearInterval(memoryLogTimer);
    memoryLogTimer = null;
  }
}
