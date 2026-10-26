import { useCallback, useEffect, useState } from "react";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { confirmAndDeleteModelProvider } from "./model-provider-section/modelProviderActions.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import type { ModelConnectivityResult } from "@zcode/shared";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refreshing: modelProvidersRefreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(false);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      const providerId = target.providerId.trim();
      const provider = modelProviders.find((item) => item.providerId === providerId);
      if (!provider || provider.config.group !== "standard-personal") {
        logger.warn("[ModelProviderSection] 无法打开目标供应商", { providerId });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }
      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(createCustomProviderNodeKey(providerId));
      return true;
    },
    [modelProviders],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget) return;
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [applyModelProviderTarget, onConsumePendingModelProviderTarget, pendingModelProviderTarget]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") return;
        applyModelProviderTarget(
          detail?.modelProviderId ? { providerId: detail.modelProviderId } : undefined,
        );
      }),
    [applyModelProviderTarget],
  );

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      modelProviders,
      modelProvidersLoading: loading,
      displayOrder,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });

  useEffect(() => {
    if (!initialModelProviderTarget) return;
    applyModelProviderTarget(initialModelProviderTarget);
  }, [applyModelProviderTarget, initialModelProviderTarget]);

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        await saveProvider(config);
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({ provider, confirmDialog, intl, deleteProvider });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = modelProviders.map((provider) => provider.providerId);
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) return;
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({ providerIds: nextProviderIds });
    },
    [modelProviders, saveDisplayOrder],
  );

  const presetLoading = loading || modelProvidersRefreshing;
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <button type="button" className="underline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      presetLoading={presetLoading}
      customLoading={customLoading}
      onRefresh={() => {
        void refresh();
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={(item) => setSelectedNodeKey(item.key)}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={new Set(navigationItems.map((item) => item.provider.providerId))}
    >
      {invalidProviderTarget || navigationUnavailable ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({ id: "settings.modelProvider.navigationUnavailable" })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => handleCreateProvider({ templateId })}
          onCreateCustom={(label) => handleCreateProvider({ providerName: label })}
        />
      ) : selectedNavItem ? (
        <ModelProviderSectionDetail
          selectedNavItem={selectedNavItem}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onOpenApiKeyUrl={(url) => platform.openExternal(url)}
          settingsRevision={providerSettingsView?.revision}
        />
      ) : (
        <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
          <p className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.emptyTitle" })}
          </p>
          <p className="max-w-md text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.emptyDescription" })}
          </p>
        </div>
      )}
    </ModelProviderSectionLayout>
  );
}
