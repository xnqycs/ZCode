import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Loader2Icon } from "lucide-react";
import { TID_MODEL_PROVIDER_NAV_ITEM, testId } from "@zcode/shared/test-ids";
import { useCallback, useMemo, type KeyboardEvent } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { ModelProviderNavGroup, ModelProviderNavItem } from "./constants.js";
import { ProviderStatusIndicator } from "./ProviderStatusIndicator.js";
import { useOptimisticReorder } from "./useOptimisticReorder.js";
import { renderModelProviderNavIcon } from "./utils.js";

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function getSortableProviderId(
  item: ModelProviderNavItem,
  reorderableProviderIds?: ReadonlySet<string>,
): string | null {
  return !reorderableProviderIds || reorderableProviderIds.has(item.provider.providerId)
    ? item.provider.providerId
    : null;
}

export function resolveReorderedProviderIdsForGroup(params: {
  activeProviderId: string;
  overProviderId: string;
  providerIds: readonly string[];
}): string[] {
  const activeIndex = params.providerIds.indexOf(params.activeProviderId);
  const overIndex = params.providerIds.indexOf(params.overProviderId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.providerIds];
  }
  return arrayMove([...params.providerIds], activeIndex, overIndex);
}

export function shouldShowModelProviderGroupLoadingIndicator(params: {
  groupId: ModelProviderNavGroup["id"];
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  return params.groupId === "custom" ? params.customLoading : params.presetLoading;
}

export function resolveModelProviderSideNavLabel(item: ModelProviderNavItem): string {
  return item.label;
}

function ModelProviderNavigationButton({
  item,
  selectedNodeKey,
  onSelectNavItem,
}: {
  item: ModelProviderNavItem;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  const isSelected = item.key === selectedNodeKey;
  return (
    <ControlHintTooltip title={item.label} side="right">
      <button
        type="button"
        aria-label={item.label}
        aria-selected={isSelected}
        data-state={isSelected ? "selected" : "idle"}
        data-testid={testId(TID_MODEL_PROVIDER_NAV_ITEM, item.key)}
        onClick={() => onSelectNavItem(item)}
        className={`relative box-border flex h-8 w-full items-center gap-2 rounded-lg border px-2 py-1 text-left text-ui-base font-medium transition-colors max-md:size-8 max-md:justify-center max-md:gap-0 max-md:px-0 ${
          isSelected
            ? "border-border-hover bg-card-selected text-foreground"
            : "border-transparent text-foreground hover:border-border-hover/60"
        }`}
      >
        <span className="shrink-0 text-current">{renderModelProviderNavIcon(item)}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 max-md:sr-only">
          <span className="min-w-0 truncate">{item.label}</span>
        </span>
        <ProviderStatusIndicator provider={item.provider} />
      </button>
    </ControlHintTooltip>
  );
}

function SortableModelProviderNavigationButton({
  item,
  selectedNodeKey,
  onSelectNavItem,
}: {
  item: ModelProviderNavItem;
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.provider.providerId,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNavItem(item);
    }
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
      className={isDragging ? "relative z-10 opacity-80" : undefined}
    >
      <ModelProviderNavigationButton
        item={item}
        selectedNodeKey={selectedNodeKey}
        onSelectNavItem={onSelectNavItem}
      />
    </div>
  );
}

export function ModelProviderSectionNavigation({
  navigationGroups,
  selectedNodeKey,
  customLoading,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
}: {
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  presetLoading: boolean;
  customLoading: boolean;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  return (
    <aside className="px-1.5 py-3 md:px-2 md:py-2">
      <div className="flex min-h-0 flex-col gap-3 max-md:gap-1">
        {navigationGroups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <ModelProviderGroup
              key={group.id}
              group={group}
              selectedNodeKey={selectedNodeKey}
              customLoading={customLoading}
              onSelectNavItem={onSelectNavItem}
              onReorderProviderIds={onReorderProviderIds}
              reorderableProviderIds={reorderableProviderIds}
              sensors={sensors}
            />
          ))}
      </div>
    </aside>
  );
}

function ModelProviderGroup({
  group,
  selectedNodeKey,
  customLoading,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  sensors,
}: {
  group: ModelProviderNavGroup;
  selectedNodeKey: string | null;
  customLoading: boolean;
  onSelectNavItem: (item: ModelProviderNavItem) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  sensors: ReturnType<typeof useSensors>;
}) {
  const providerIds = useMemo(
    () =>
      group.items
        .filter((item) => !reorderableProviderIds || reorderableProviderIds.has(item.provider.providerId))
        .map((item) => item.provider.providerId),
    [group.items, reorderableProviderIds],
  );
  const optimisticOrder = useOptimisticReorder({
    authoritativeIds: group.items.map((item) => item.provider.providerId),
    persist: async (nextProviderIds) => {
      await onReorderProviderIds?.([...nextProviderIds]);
    },
  });
  const renderedItems = useMemo(() => {
    const byId = new Map(group.items.map((item) => [item.provider.providerId, item]));
    return optimisticOrder.renderedIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  }, [group.items, optimisticOrder.renderedIds]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const nextProviderIds = resolveReorderedProviderIdsForGroup({
        activeProviderId: String(active.id),
        overProviderId: String(over.id),
        providerIds: renderedItems.map((item) => item.provider.providerId),
      });
      void optimisticOrder.commit(nextProviderIds).catch(() => undefined);
    },
    [onReorderProviderIds, optimisticOrder, renderedItems],
  );

  return (
    <div className="flex flex-col gap-2 max-md:gap-1">
      <div className="flex h-7 items-center justify-between px-2 py-1 max-md:hidden">
        <h3 className="text-ui-sm font-semibold text-foreground-subtlest">{group.title}</h3>
        {customLoading ? (
          <Loader2Icon className="size-3 animate-spin text-foreground-subtlest" />
        ) : null}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={providerIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1 max-md:items-center">
            {renderedItems.map((item) => (
              <SortableModelProviderNavigationButton
                key={item.key}
                item={item}
                selectedNodeKey={selectedNodeKey}
                onSelectNavItem={onSelectNavItem}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
