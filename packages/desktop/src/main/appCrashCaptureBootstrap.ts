import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir 之后执行，再配置 crashDumps 与本地归档。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(logger);
