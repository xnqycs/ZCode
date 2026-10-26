# Coding/Start Plan removal

## Scope

- Remove Coding Plan, Team Plan, and Start Plan purchase, entitlement, quota, reset, and usage surfaces from the desktop app.
- Remove the upgrade dialog provider, payment webview, plan cards, sidebar upgrade/badge, chat quota banners, Start recommendations, and plan-specific usage tabs.
- Narrow Model Settings to custom/API-key providers; remove built-in plan provider navigation and plan connection modes.
- Retain custom provider execution, OAuth login, App Usage, Rewards, marketing delivery, desktop help utilities, dynamic workflow, and force update.

## Service boundary

- `ICodingPlanSubscriptionService` and `packages/services/src/coding-plan-subscription` are deleted.
- `IUsageStatsService` is narrowed to `getAppUsageSnapshot`; plan quota/entitlement/reset methods and providers are deleted.
- Dynamic Workflow config moved to `IClientConfigService`; Rewards partition cleanup is independent of the legacy Coding Plan partition.
- Existing account-provider execution and OAuth credentials are retained for compatibility; no plan purchase or entitlement UI remains.

## Data and compatibility

- Old plan provider selections are no longer reachable from Settings; unknown targets show the existing navigation-unavailable message.
- The legacy `persist:zcode-coding-plan` partition cleanup command remains for logout/Clear All Data security until a one-time migration replaces it.
- Plan-specific docs, tests, fixtures, and capability-map entries are removed or marked historical.

## Acceptance

- Desktop/Web settings show only custom providers; no plan purchase/upgrade entry exists.
- Help menu retains only desktop utilities; Web/mobile render no help trigger.
- App Usage, custom provider CRUD/test, OAuth login, Rewards, and dynamic workflow pass existing regressions.
- Typecheck, lint, architecture check, and targeted unit/E2E suites pass.
