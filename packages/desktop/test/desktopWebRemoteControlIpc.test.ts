import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type WebRemoteControlContext } from "@zcode/shared";
import type { WebRemoteControlStartAuthorization } from "../src/main/webRemoteControlManager.js";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
}));

function withStartAuthorization(manager: {
  start(windowId: number, context: WebRemoteControlContext): Promise<unknown>;
  stop(windowId: number): Promise<void>;
  getStatus(windowId: number): unknown;
}) {
  return {
    ...manager,
    notifyAuthStateChanged: vi.fn(async () => {}),
    authorizeStart: vi.fn(
      (windowId: number, context: WebRemoteControlContext): WebRemoteControlStartAuthorization => ({
        token: `ticket-${windowId}`,
        expiresAt: Date.now() + 30_000,
        windowId,
        workspaceKey: context.workspaceIdentity?.trim() || context.workspacePath,
        ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
      }),
    ),
    startAuthorized: vi.fn(
      (
        windowId: number,
        context: WebRemoteControlContext,
        _authorization: WebRemoteControlStartAuthorization,
      ) => manager.start(windowId, context),
    ),
  };
}

vi.mock("electron", () => ({
  app: {
    getLocale: vi.fn(() => "zh-CN"),
    getPreferredSystemLanguages: vi.fn(() => ["zh-CN"]),
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    on: vi.fn((channel: string, listener: IpcHandler) => h.listeners.set(channel, listener)),
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
  },
  dialog: {
    showMessageBox: h.showMessageBox,
  },
}));

describe("Web Remote Control IPC telemetry", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.fromWebContents.mockReturnValue({ id: 17 });
    h.showMessageBox.mockReset();
    h.showMessageBox.mockResolvedValue({ response: 1 });
  });

  it("登录通知仅接受真实窗口与严格payload，不接收renderer指定的凭据或窗口", async () => {
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    const manager = withStartAuthorization({ start: vi.fn(), stop: vi.fn(), getStatus: vi.fn() });
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: manager,
    });
    const notify = h.listeners.get(PlatformChannels.WebRemoteControlAuthStateChanged)!;
    for (const payload of [
      null,
      {},
      { state: "signed-in", jwt: "secret" },
      { state: "signed-out", windowId: 9 },
    ]) {
      notify({ sender: { id: 73 } }, payload);
    }
    expect(manager.notifyAuthStateChanged).not.toHaveBeenCalled();
    notify({ sender: { id: 73 } }, { state: "signed-in" });
    expect(manager.notifyAuthStateChanged).toHaveBeenCalledWith(17, { state: "signed-in" });
    manager.notifyAuthStateChanged.mockClear();
    h.fromWebContents.mockReturnValue(null);
    notify({ sender: { id: 73 } }, { state: "signed-out" });
    expect(manager.notifyAuthStateChanged).not.toHaveBeenCalled();
  });
  it("只注册start/stop/status，不再暴露刷新配对IPC", async () => {
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: withStartAuthorization({
        start: vi.fn(),
        stop: vi.fn(),
        getStatus: vi.fn(),
      }),
    });
    expect([...h.handlers.keys()].sort()).toEqual(
      [
        PlatformChannels.StartWebRemoteControl,
        PlatformChannels.StopWebRemoteControl,
        PlatformChannels.GetWebRemoteControlStatus,
      ].sort(),
    );
  });

  it("内部票据只在 manager 提供的目标绑定接口中使用一次", async () => {
    const authorization: WebRemoteControlStartAuthorization = {
      token: "ticket-1",
      expiresAt: Date.now() + 30_000,
      windowId: 17,
      workspaceKey: "/workspace/local",
    };
    const authorizeStart = vi.fn(() => authorization);
    const startAuthorized = vi.fn(async () => ({ status: "running" }));
    const { registerWebRemoteControlIpcHandlers } =
      await import("../src/main/desktopWebRemoteControlIpc.js");
    registerWebRemoteControlIpcHandlers({
      reportRemoteUsageEvent: vi.fn(),
      webRemoteControlManager: {
        startAuthorized,
        authorizeStart,
        stop: vi.fn(),
        getStatus: vi.fn(),
      },
    });

    const context = { workspacePath: "/workspace/local" };
    await expect(
      h.handlers.get(PlatformChannels.StartWebRemoteControl)?.({ sender: { id: 78 } }, context),
    ).resolves.toEqual({ status: "running" });
    expect(authorizeStart).toHaveBeenCalledWith(17, context);
    expect(startAuthorized).toHaveBeenCalledWith(17, context, authorization);
  });
});
