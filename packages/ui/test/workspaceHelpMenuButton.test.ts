import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopCommandIds } from "@zcode/shared";
import { TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER } from "@zcode/shared/test-ids";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

const captured = vi.hoisted(() => ({
  exportLogs: vi.fn(async () => ({ success: true })),
  toast: vi.fn(() => 7),
  dismissToast: vi.fn(),
  menuItems: [] as Array<{
    label: string;
    testId?: string;
    disabled?: boolean;
    onSelect?: () => void;
  }>,
  executeDesktopCommand: vi.fn(async () => undefined),
  updateMenu: {
    visible: true,
    disabled: false,
    labelId: "titleBar.menu.help.checkForUpdates",
    labelValues: undefined,
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    captured.menuItems.push({ label, testId, onSelect, disabled });
    return createElement("div", { "data-testid": testId }, children);
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
vi.mock("@/components/ui/toast.js", () => ({
  toast: captured.toast,
  dismissToast: captured.dismissToast,
}));
vi.mock("@/hooks/useDesktopUpdateMenu.js", () => ({
  useDesktopUpdateMenu: (isDesktop: boolean) => ({
    ...captured.updateMenu,
    visible: isDesktop && captured.updateMenu.visible,
    checkForUpdates: () => captured.executeDesktopCommand(DesktopCommandIds.CheckForUpdates),
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: captured.executeDesktopCommand,
    exportLogs: captured.exportLogs,
    openExternal: vi.fn(),
  }),
}));

describe("WorkspaceHelpMenuButton", () => {
  async function render(isDesktop: boolean) {
    captured.menuItems = [];
    captured.executeDesktopCommand.mockClear();
    captured.exportLogs.mockClear();
    const { WorkspaceHelpMenuButton } = await import("@/WorkspaceHelpMenuButton.js");
    return renderToStaticMarkup(createElement(WorkspaceHelpMenuButton, { isDesktop }));
  }

  it("desktop keeps only the utility group", async () => {
    const html = await render(true);
    expect(captured.menuItems.map((item) => item.label)).toEqual([
      "titleBar.menu.help.exportLogs",
      "titleBar.menu.help.resourceManager",
      "titleBar.menu.help.checkForUpdates",
      "titleBar.menu.help.about",
    ]);
    expect(html).not.toContain("workspaceHeader.help.issueReport");
    expect(html).not.toContain("workspaceHeader.help.community");
    expect(html).not.toContain("workspaceHeader.help.docs");
    expect(html).not.toContain("<hr");
  });

  it("web and mobile remote render no empty help trigger", async () => {
    expect(await render(false)).toBe("");
    expect(captured.menuItems).toEqual([]);
  });

  it("resource manager, update, about, and export use existing commands", async () => {
    await render(true);
    await captured.menuItems[0]?.onSelect?.();
    expect(captured.exportLogs).toHaveBeenCalledOnce();
    const resource = captured.menuItems.find(
      (item) => item.testId === TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
    );
    await resource?.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledWith(
      DesktopCommandIds.OpenResourceManager,
    );
    await captured.menuItems[2]?.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.CheckForUpdates);
    await captured.menuItems[3]?.onSelect?.();
    expect(captured.executeDesktopCommand).toHaveBeenCalledWith(DesktopCommandIds.ShowAbout);
  });
});
