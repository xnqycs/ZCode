import type { OAuthProviderId } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

/**
 * Coding/Start/Team plan connection selection was removed with the plan entitlement
 * services. OAuth login remains purely an authentication fact; there is no plan
 * connection to auto-select after login or restore.
 */
export async function refreshLatestModelProviderFamilySelectionAfterLogin(_params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<null> {
  return null;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(_params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<null> {
  return null;
}
