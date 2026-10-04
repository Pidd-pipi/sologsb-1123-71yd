import { create } from 'zustand';
import { backfillMissionSorties, db, deleteSortiesByMission, loadAllSorties, replaceMissionSorties } from '../utils/db';
import { replanSorties } from '../utils/sortieReconcile';
import { useAssetStore } from './assetStore';
import type { ImageAsset } from '../types/imageasset';
import type { RouteParamSig, Sortie, SortieStatus } from '../types/sortie';
import type { Waypoint } from '../types/waypoint';

interface SavePlanResult {
  reviewCount: number;
  keptCount: number;
  newCount: number;
  /** 重算后仍在待复核队列的影像总数（任务内） */
  reviewTotal: number;
}

interface SortieState {
  items: Sortie[];
  loaded: boolean;
  load: () => Promise<void>;
  byMission: (missionId: string) => Sortie[];
  /** 保存航线参数时按续航重算：已编目架次保持原样，未飞重划，受影响影像列待复核 */
  savePlan: (args: {
    missionId: string;
    waypoints: Waypoint[];
    assets: ImageAsset[];
    route: RouteParamSig;
  }) => Promise<SavePlanResult>;
  /** 旧数据兼容：无架次任务按已有影像航点补归属，返回新建架次数 */
  ensureBackfill: (missionId: string) => Promise<number>;
  /** 编目影像挂到架次后，把未飞架次置为已飞（锁定，后续重算不再动它） */
  markFlown: (sortieIds: string[]) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
}

export const useSortieStore = create<SortieState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await loadAllSorties();
    set({ items: rows, loaded: true });
  },
  byMission(missionId) {
    return get()
      .items.filter((s) => s.missionId === missionId)
      .sort((a, b) => a.sortieNo - b.sortieNo);
  },
  async savePlan({ missionId, waypoints, assets, route }) {
    const existing = get().byMission(missionId);
    const result = replanSorties({ missionId, existing, waypoints, assets, route });
    // 架次增删与影像归属更新放同一个 IndexedDB 事务
    await replaceMissionSorties(missionId, result.sorties, result.removedSortieIds, result.assetPatches);
    useAssetStore.getState().applyPatches(result.assetPatches);

    const kept = existing.filter((s) => !result.removedSortieIds.includes(s.id));
    set({
      items: [...get().items.filter((s) => s.missionId !== missionId), ...result.sorties],
    });
    const reviewTotal = useAssetStore
      .getState()
      .items.filter((a) => a.missionId === missionId && a.needsReview).length;
    return {
      reviewCount: result.reviewAssetIds.length,
      keptCount: kept.length,
      newCount: result.sorties.length - kept.length,
      reviewTotal,
    };
  },
  async ensureBackfill(missionId) {
    if (get().items.some((s) => s.missionId === missionId)) return 0;
    const { created, assetPatches } = await backfillMissionSorties(missionId);
    if (created.length === 0) return 0;
    set({ items: [...get().items, ...created] });
    useAssetStore.getState().applyPatches(assetPatches);
    return created.length;
  },
  async markFlown(sortieIds) {
    if (sortieIds.length === 0) return;
    const idSet = new Set(sortieIds);
    const now = Date.now();
    const changed = get()
      .items.filter((s) => idSet.has(s.id) && s.status !== 'flown')
      .map((s) => ({ ...s, status: 'flown' as SortieStatus, updatedAt: now }));
    if (changed.length === 0) return;
    await db.sorties.bulkPut(changed);
    set({
      items: get().items.map((s) =>
        idSet.has(s.id) ? { ...s, status: 'flown' as SortieStatus, updatedAt: now } : s,
      ),
    });
  },
  async removeByMission(missionId) {
    await deleteSortiesByMission(missionId);
    set({ items: get().items.filter((s) => s.missionId !== missionId) });
  },
}));
