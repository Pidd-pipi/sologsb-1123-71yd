import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Sortie, SortieDraft } from '../types/sortie';
import type { Waypoint } from '../types/waypoint';
import type { ImageAsset } from '../types/imageasset';
import type { RouteMetrics, RouteParams } from '../hooks/useRouteMetrics';
import {
  assignImageToSortie,
  buildSortieDrafts,
  reconcileSorties,
  splitWaypointsToSorties,
} from '../utils/sortieCalc';
import { useAssetStore } from './assetStore';

interface SortieState {
  items: Sortie[];
  loaded: boolean;
  load: () => Promise<void>;
  /**
   * 按新的航线参数重算架次划分：
   * - 已飞架次（有影像）保持原样
   * - 待飞架次删除，按新参数重建
   * - 影像按航点范围重新归架，归属变化的标记待复核
   */
  recalculate: (
    missionId: string,
    params: RouteParams,
    metrics: RouteMetrics,
    waypoints: Waypoint[],
    assets: ImageAsset[],
  ) => Promise<void>;
  /** 按航点范围把影像归到对应架次，并回填状态 */
  assignAndReconcile: (missionId: string, waypoints: Waypoint[], assets: ImageAsset[]) => Promise<void>;
  /** 旧数据兼容：有影像但无架次时，按影像航点补上归属 */
  ensureLegacy: (missionId: string, waypoints: Waypoint[], assets: ImageAsset[]) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  byMission: (missionId: string) => Sortie[];
}

export const useSortieStore = create<SortieState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.sorties.toArray();
    rows.sort((a, b) => a.sortieNo - b.sortieNo);
    set({ items: rows, loaded: true });
  },
  async recalculate(missionId, params, metrics, waypoints, assets) {
    const existing = get().items.filter((s) => s.missionId === missionId);
    // 有影像的架次视为已飞，保持原样
    const flown = existing.filter((s) => assets.some((a) => a.sortieId === s.id));
    // 待飞架次删除
    const pendingIds = existing.filter((s) => !assets.some((a) => a.sortieId === s.id)).map((s) => s.id);
    if (pendingIds.length > 0) {
      await db.sorties.bulkDelete(pendingIds);
    }

    const splits = splitWaypointsToSorties(waypoints, metrics.estPhotos, metrics.estDuration);
    const snapshot = {
      altitude: params.altitude,
      overlapForward: params.overlapForward,
      overlapSide: params.overlapSide,
      heading: params.heading,
      gsd: metrics.gsd,
      spacing: metrics.spacing,
      photoInterval: metrics.photoInterval,
      estPhotosTotal: metrics.estPhotos,
      estDurationTotal: metrics.estDuration,
      batteryCount: metrics.batteryCount,
    };
    const drafts = buildSortieDrafts(splits, missionId, snapshot);
    const newSorties: Sortie[] = [];
    for (const draft of drafts) {
      // 与已飞架次范围重叠的跳过（保持原样，避免双重覆盖）
      const overlapsFlown = flown.some(
        (f) => draft.fromSeq <= f.toSeq && draft.toSeq >= f.fromSeq,
      );
      if (overlapsFlown) continue;
      const record: Sortie = { ...draft, id: newId('sortie'), createdAt: Date.now() };
      newSorties.push(record);
    }
    if (newSorties.length > 0) {
      await db.sorties.bulkPut(newSorties);
    }

    // 合并已飞 + 新建
    const allForMission = [...flown, ...newSorties].sort((a, b) => a.sortieNo - b.sortieNo);

    // 重新归架：归属变化的影像标记待复核
    const assetUpdates: { id: string; patch: Partial<ImageAsset> }[] = [];
    assets.forEach((a) => {
      const assigned = assignImageToSortie(a, waypoints, allForMission);
      const nextSortieId = assigned?.id;
      if (nextSortieId !== a.sortieId) {
        assetUpdates.push({
          id: a.id,
          patch: {
            sortieId: nextSortieId,
            needsReview: true,
            reviewReason: a.sortieId ? '架次划分已更新，归属待复核' : '按航点补录架次归属',
          },
        });
      }
    });
    for (const { id, patch } of assetUpdates) {
      await db.assets.update(id, patch);
    }
    // 同步影像内存状态
    if (assetUpdates.length > 0) {
      useAssetStore.getState().patchState(assetUpdates);
    }

    // 回填状态
    const reconciled = reconcileSorties(allForMission, waypoints, assets);
    const statusUpdates = reconciled
      .filter((s) => flown.some((f) => f.id === s.id) === false) // 已飞架次状态不动
      .map((s) => ({ id: s.id, status: s.status }));
    for (const { id, status } of statusUpdates) {
      await db.sorties.update(id, { status });
    }

    // 同步 store
    const otherMissions = get().items.filter((s) => s.missionId !== missionId);
    const updatedFlown = flown.map((f) => {
      const r = reconciled.find((x) => x.id === f.id);
      return r ? { ...f, status: r.status } : f;
    });
    set({ items: [...otherMissions, ...updatedFlown, ...newSorties].sort((a, b) => a.sortieNo - b.sortieNo) });
  },
  async assignAndReconcile(missionId, waypoints, assets) {
    const sorties = get().items.filter((s) => s.missionId === missionId);
    if (sorties.length === 0) return;
    const reconciled = reconcileSorties(sorties, waypoints, assets);
    // 回填影像归属，归属变化的标记待复核
    const assetUpdates: { id: string; patch: Partial<ImageAsset> }[] = [];
    assets.forEach((a) => {
      const assigned = assignImageToSortie(a, waypoints, sorties);
      if (assigned?.id !== a.sortieId) {
        assetUpdates.push({
          id: a.id,
          patch: {
            sortieId: assigned?.id,
            needsReview: true,
            reviewReason: a.sortieId ? '架次归属已调整，待复核' : '按航点补录架次归属',
          },
        });
      }
    });
    for (const { id, patch } of assetUpdates) {
      await db.assets.update(id, patch);
    }
    // 同步影像内存状态
    if (assetUpdates.length > 0) {
      useAssetStore.getState().patchState(assetUpdates);
    }
    // 回填架次状态
    for (const s of reconciled) {
      await db.sorties.update(s.id, { status: s.status });
    }
    set({
      items: get().items.map((s) => {
        if (s.missionId !== missionId) return s;
        const r = reconciled.find((x) => x.id === s.id);
        return r ? { ...s, status: r.status } : s;
      }),
    });
  },
  async ensureLegacy(missionId, waypoints, assets) {
    const existing = get().items.filter((s) => s.missionId === missionId);
    if (existing.length > 0) return;
    const missionAssets = assets.filter((a) => a.missionId === missionId);
    if (missionAssets.length === 0) return;
    // 按影像最近航点的 seq 范围补架次
    const seqs = missionAssets
      .map((a) => {
        let best: Waypoint | undefined;
        let bestDist = Number.POSITIVE_INFINITY;
        waypoints.forEach((w) => {
          const d = Math.hypot(w.lng - a.lng, w.lat - a.lat);
          if (d < bestDist) {
            bestDist = d;
            best = w;
          }
        });
        return best?.seq;
      })
      .filter((s): s is number => s !== undefined);
    if (seqs.length === 0) return;
    const fromSeq = Math.min(...seqs);
    const toSeq = Math.max(...seqs);
    const record: Sortie = {
      id: newId('sortie'),
      missionId,
      sortieNo: 1,
      fromSeq,
      toSeq,
      estPhotos: missionAssets.length,
      estDuration: 0,
      status: '已飞',
      altitude: 0,
      overlapForward: 0,
      overlapSide: 0,
      heading: 0,
      gsd: 0,
      spacing: 0,
      photoInterval: 0,
      estPhotosTotal: missionAssets.length,
      estDurationTotal: 0,
      batteryCount: 1,
      createdAt: Date.now(),
    };
    await db.sorties.put(record);
    // 回填影像归属
    const patches = missionAssets.map((a) => ({ id: a.id, patch: { sortieId: record.id } }));
    for (const { id, patch } of patches) {
      await db.assets.update(id, patch);
    }
    useAssetStore.getState().patchState(patches);
    set({ items: [...get().items, record] });
  },
  async removeByMission(missionId) {
    const ids = get().items.filter((s) => s.missionId === missionId).map((s) => s.id);
    await db.sorties.bulkDelete(ids);
    set({ items: get().items.filter((s) => s.missionId !== missionId) });
  },
  byMission(missionId) {
    return get().items.filter((s) => s.missionId === missionId).sort((a, b) => a.sortieNo - b.sortieNo);
  },
}));
