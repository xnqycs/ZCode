import { create } from "zustand";
import type {
  OffPeakTaskCreateResult,
  OffPeakTakeNumberAvailability,
  ZCodeOffPeakTask,
  ModelSelection,
} from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import { logger } from "@/logger.js";

export interface CreateOffPeakTaskInput {
  title: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface UpdateOffPeakTaskInput {
  title?: string;
  prompt?: string;
  permissionMode?: string;
  modelSelection?: ModelSelection | null;
}

export interface OffPeakCreateDraft {
  title?: string;
  prompt?: string;
}

export type OffPeakTakeNumberAvailabilityStatus = "idle" | "loading" | "ready" | "error";

interface OffPeakTaskState {
  tasks: ZCodeOffPeakTask[];
  loading: boolean;
  error: string | null;
  operationId: string | null;
  /** Off-Peak gray config was served by the deleted plan subscription service. */
  grayConfig: { enabled: boolean } | null;
  codingPlanSupport: null;
  takeNumberAvailability: OffPeakTakeNumberAvailability | null;
  takeNumberAvailabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  newTaskBannerDismissed: boolean;
  pendingCreateDraft: OffPeakCreateDraft | null;
  initialize(deps: { offPeakTaskService: IOffPeakTaskService }): Promise<void>;
  refresh(service: IOffPeakTaskService): Promise<void>;
  refreshCodingPlanSupport(service: IOffPeakTaskService, freshnessKey?: string): Promise<void>;
  refreshTakeNumberAvailability(service: IOffPeakTaskService): Promise<void>;
  createTask(
    input: CreateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<OffPeakTaskCreateResult>;
  updateTask(
    offPeakTaskId: string,
    input: UpdateOffPeakTaskInput,
    service: IOffPeakTaskService,
  ): Promise<ZCodeOffPeakTask | null>;
  pauseTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  continueTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  cancelTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteTask(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  deleteHistory(offPeakTaskId: string, service: IOffPeakTaskService): Promise<void>;
  dismissNewTaskBanner(): void;
  setPendingCreateDraft(draft: OffPeakCreateDraft): void;
  consumePendingCreateDraft(): OffPeakCreateDraft | null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isOffPeakQuotaError(result: OffPeakTaskCreateResult | null | undefined): boolean {
  return (
    result?.ok === false && result.errorCategory === "quota_3103" && result.errorCode === "3103"
  );
}

export type OffPeakCreateErrorMessageId =
  | "offPeak.error.quota"
  | "offPeak.error.unavailable"
  | "offPeak.error.generic";

export function resolveOffPeakCreateErrorMessageId(
  result: OffPeakTaskCreateResult | null | undefined,
): OffPeakCreateErrorMessageId {
  if (isOffPeakQuotaError(result)) return "offPeak.error.quota";
  if (
    result?.ok === false &&
    (result.errorCategory === "network" ||
      result.errorCategory === "invalid_response" ||
      result.errorCategory === "unknown")
  ) {
    return "offPeak.error.unavailable";
  }
  return "offPeak.error.generic";
}

export const useOffPeakTaskStore = create<OffPeakTaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  operationId: null,
  grayConfig: null,
  codingPlanSupport: null,
  takeNumberAvailability: null,
  takeNumberAvailabilityStatus: "idle",
  newTaskBannerDismissed: false,
  pendingCreateDraft: null,

  async initialize({ offPeakTaskService }) {
    set({ loading: true, error: null });
    try {
      const tasks = await offPeakTaskService.list();
      set({ tasks, grayConfig: null, loading: false });
    } catch (error) {
      logger.warn("[off-peak] list failed", toErrorMessage(error));
      set({ tasks: [], loading: false, error: toErrorMessage(error) });
    }
  },

  async refresh(service) {
    try {
      const tasks = await service.list();
      set({ tasks, error: null });
    } catch (error) {
      set({ error: toErrorMessage(error) });
    }
  },

  async refreshCodingPlanSupport() {},

  async refreshTakeNumberAvailability(service) {
    try {
      const takeNumberAvailability = await service.getTakeNumberAvailability();
      set({ takeNumberAvailability, takeNumberAvailabilityStatus: "ready" });
    } catch (error) {
      set({
        takeNumberAvailability: null,
        takeNumberAvailabilityStatus: "error",
        error: toErrorMessage(error),
      });
    }
  },

  async createTask(input, service) {
    const operationId = `offpeak-create-${Date.now()}`;
    set({ operationId });
    try {
      return await service.createTask(input as never);
    } finally {
      set({ operationId: null });
    }
  },

  async updateTask(offPeakTaskId, input, service) {
    const result = await service.updateTask(offPeakTaskId, input);
    await get().refresh(service);
    return result;
  },

  async pauseTask(offPeakTaskId, service) {
    await service.pauseTask(offPeakTaskId);
    await get().refresh(service);
  },

  async continueTask(offPeakTaskId, service) {
    await service.continueTask(offPeakTaskId);
    await get().refresh(service);
  },

  async cancelTask(offPeakTaskId, service) {
    await service.cancelTask(offPeakTaskId);
    await get().refresh(service);
  },

  async deleteTask(offPeakTaskId, service) {
    await service.deleteTask(offPeakTaskId);
    await get().refresh(service);
  },

  async deleteHistory(offPeakTaskId, service) {
    await service.deleteHistory(offPeakTaskId);
    await get().refresh(service);
  },

  dismissNewTaskBanner() {
    set({ newTaskBannerDismissed: true });
  },

  setPendingCreateDraft(draft) {
    set({ pendingCreateDraft: draft });
  },

  consumePendingCreateDraft() {
    const draft = get().pendingCreateDraft;
    set({ pendingCreateDraft: null });
    return draft;
  },
}));
