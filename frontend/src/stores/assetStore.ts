import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';

/** 编目时随影像一并落库的架次归属 */
export interface AssetRefs {
  waypointId?: string;
  sortieId?: string;
  needsReview?: boolean;
}

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  addMany: (drafts: ImageAssetDraft[], refs?: (AssetRefs | undefined)[]) => Promise<ImageAsset[]>;
  update: (id: string, patch: Partial<ImageAsset>) => Promise<void>;
  markMany: (ids: string[], quality: ImageQuality) => Promise<void>;
  clearReview: (ids: string[]) => Promise<void>;
  /** 架次重算/旧数据补录后，把归属与待复核补丁同步进内存 */
  applyPatches: (patches: { id: string; patch: Partial<ImageAsset> }[]) => void;
  removeMany: (ids: string[]) => Promise<void>;
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (missionId: string) => { quality: ImageQuality; count: number }[];
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  loaded: false,
  async load() {
    const rows = await db.assets.toArray();
    rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs, loaded: true });
  },
  async refresh() {
    const rows = await db.assets.toArray();
    rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
    set({ items: rows });
  },
  async addMany(drafts, refs) {
    const records: ImageAsset[] = drafts.map((d, i) => ({ ...d, id: newId('asset'), ...(refs?.[i] ?? {}) }));
    const thumbRecords: AssetThumb[] = records.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
    }));
    // 缩略图单独建表存放
    await db.assets.bulkPut(records);
    await db.thumbs.bulkPut(thumbRecords);
    const nextThumbs = { ...get().thumbs };
    thumbRecords.forEach((t) => {
      nextThumbs[t.id] = t.dataUrl;
    });
    set({ items: [...get().items, ...records], thumbs: nextThumbs });
    return records;
  },
  async update(id, patch) {
    await db.assets.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async markMany(ids, quality) {
    for (const id of ids) {
      await db.assets.update(id, { quality });
    }
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, quality } : it)) });
  },
  async clearReview(ids) {
    for (const id of ids) {
      await db.assets.update(id, { needsReview: false });
    }
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, needsReview: false } : it)) });
  },
  applyPatches(patches) {
    const map = new Map(patches.map((p) => [p.id, p.patch]));
    set({ items: get().items.map((it) => (map.has(it.id) ? { ...it, ...map.get(it.id) } : it)) });
  },
  async removeMany(ids) {
    await db.assets.bulkDelete(ids);
    await db.thumbs.bulkDelete(ids);
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    set({ items: get().items.filter((it) => !ids.includes(it.id)), thumbs: nextThumbs });
  },
  byMission(missionId) {
    return get().items.filter((it) => it.missionId === missionId);
  },
  qualityStats(missionId) {
    const list = get().items.filter((it) => it.missionId === missionId);
    return (['合格', '模糊', '过曝'] as ImageQuality[]).map((quality) => ({
      quality,
      count: list.filter((it) => it.quality === quality).length,
    }));
  },
}));
