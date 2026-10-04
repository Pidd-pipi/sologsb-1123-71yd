import type { ImageAsset } from '../types/imageasset';
import {
  ASSET_WP_MATCH_TOLERANCE_M,
  type PlannedSortieSeed,
  type ReconcileStatus,
  type RouteParamSig,
  type Sortie,
} from '../types/sortie';
import type { Waypoint } from '../types/waypoint';
import { distanceMeters } from './geoCalc';
import { newId } from './id';
import { planWaypointSorties, routeParamsSig, waypointFingerprint } from '../types/sortie';

export interface WaypointMatch {
  /** 影像对应航点（持久化 waypointId 优先，否则就近匹配） */
  waypoint?: Waypoint;
  /** 匹配距离 m */
  distanceM: number;
  /** 是否在容差内 */
  matched: boolean;
}

export interface SortieReconcile {
  sortie: Sortie;
  /** 归到该架次的影像（持久化 sortieId 优先，其次按航点区间） */
  assets: ImageAsset[];
  /** 实到张数 */
  actualCount: number;
  /** 预计张数 */
  estCount: number;
  /** 区间内拍照航点 */
  photoWaypoints: Waypoint[];
  /** 没有任何影像的拍照航点 */
  missingWaypoints: Waypoint[];
  /** 缺拍张数（航点缺拍优先；否则按预计张数差额） */
  missingCount: number;
  status: ReconcileStatus;
  /** 该架次待复核影像数 */
  reviewCount: number;
}

/** 为单张影像找对应航点：waypointId 直连，否则就近匹配（容差外视为未匹配） */
export function matchAssetWaypoint(
  asset: ImageAsset,
  waypoints: Waypoint[],
): WaypointMatch {
  const linked = asset.waypointId ? waypoints.find((w) => w.id === asset.waypointId) : undefined;
  if (linked) return { waypoint: linked, distanceM: 0, matched: true };

  let best: Waypoint | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  waypoints.forEach((w) => {
    const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  });
  if (best && bestDist <= ASSET_WP_MATCH_TOLERANCE_M) {
    return { waypoint: best, distanceM: bestDist, matched: true };
  }
  return { waypoint: best, distanceM: Number.isFinite(bestDist) ? bestDist : Number.POSITIVE_INFINITY, matched: false };
}

/** 任务级影像 → 航点匹配，避免同一航点被多张影像重复占位（最近者优先，其余退回就近） */
export function matchAssetsToWaypoints(
  assets: ImageAsset[],
  waypoints: Waypoint[],
): Map<string, WaypointMatch> {
  const result = new Map<string, WaypointMatch>();
  const occupied = new Set<string>();
  // 先放直连与距离最近的
  const scored = assets
    .map((asset) => ({ asset, match: matchAssetWaypoint(asset, waypoints) }))
    .sort((a, b) => a.match.distanceM - b.match.distanceM);

  scored.forEach(({ asset, match }) => {
    if (match.waypoint && match.matched && !occupied.has(match.waypoint.id)) {
      occupied.add(match.waypoint.id);
      result.set(asset.id, match);
    }
  });
  // 被占走的影像：退化为最近航点但不占位（标记未匹配）
  scored.forEach(({ asset, match }) => {
    if (!result.has(asset.id)) result.set(asset.id, match);
  });
  return result;
}

function inRange(wp: Waypoint, s: Sortie): boolean {
  return wp.seq >= s.wpStartSeq && wp.seq <= s.wpEndSeq;
}

/**
 * 架次对账：影像按航点归到对应架次；张数不足或航点没有影像 → 漏拍。
 * 归组优先级：影像持久化 sortieId > 匹配航点所在架次区间。
 */
export function reconcileSorties(
  sorties: Sortie[],
  waypoints: Waypoint[],
  assets: ImageAsset[],
): { rows: SortieReconcile[]; unassignedAssets: ImageAsset[]; unassignedWaypoints: Waypoint[] } {
  const sortedSorties = [...sorties].sort((a, b) => a.sortieNo - b.sortieNo);
  const matches = matchAssetsToWaypoints(assets, waypoints);
  const assigned = new Set<string>();

  const rows: SortieReconcile[] = sortedSorties.map((sortie) => {
    const inSortieWps = waypoints.filter((w) => inRange(w, sortie));
    const photoWps = inSortieWps.filter((w) => w.action === '拍照');

    const inAssets = assets.filter((a) => {
      if (a.sortieId === sortie.id) return true;
      const m = matches.get(a.id);
      return !!m?.matched && !!m.waypoint && inRange(m.waypoint, sortie);
    });
    inAssets.forEach((a) => assigned.add(a.id));

    const coveredWpIds = new Set<string>();
    inAssets.forEach((a) => {
      const m = matches.get(a.id);
      if (m?.matched && m.waypoint && inRange(m.waypoint, sortie)) coveredWpIds.add(m.waypoint.id);
    });
    const missingWaypoints = photoWps.filter((w) => !coveredWpIds.has(w.id));
    let missingCount: number;
    if (missingWaypoints.length > 0) {
      missingCount = missingWaypoints.length;
    } else {
      missingCount = Math.max(0, sortie.estPhotos - inAssets.length);
    }

    const status: ReconcileStatus =
      sortie.status === 'unflown' && inAssets.length === 0
        ? 'unflown'
        : missingCount > 0
          ? 'short'
          : 'ok';

    return {
      sortie,
      assets: inAssets,
      actualCount: inAssets.length,
      estCount: sortie.estPhotos,
      photoWaypoints: photoWps,
      missingWaypoints,
      missingCount,
      status,
      reviewCount: inAssets.filter((a) => a.needsReview).length,
    };
  });

  const coveredRanges = new Set<number>();
  sortedSorties.forEach((s) => {
    waypoints.forEach((w) => {
      if (inRange(w, s)) coveredRanges.add(w.seq);
    });
  });
  const unassignedAssets = assets.filter((a) => !assigned.has(a.id));
  const unassignedWaypoints = waypoints.filter((w) => !coveredRanges.has(w.seq));

  return { rows, unassignedAssets, unassignedWaypoints };
}

/** 架次是否已编目（flown 即锁定，重算时保持原样）；判定权只看状态 */
export function isSortieLocked(sortie: Sortie): boolean {
  return sortie.status === 'flown';
}

export interface ReplanResult {
  sorties: Sortie[];
  removedSortieIds: string[];
  /** 需要落库的影像更新（waypointId/sortieId/needsReview） */
  assetPatches: { id: string; patch: Partial<ImageAsset> }[];
  /** 受影响被列入待复核的影像 id */
  reviewAssetIds: string[];
}

/**
 * 航高或重叠率一变化即按新参数重算：
 * - 已编目（flown）架次保持原样，不动其航点区间与影像；
 * - 未飞架次作废，其航点区间（以及不在任何保留架次区间的航点）按新参数重划；
 * - 航点编辑后落进重划区、或直连在作废架次上的影像列待复核并按航点重新归位。
 */
export function replanSorties(params: {
  missionId: string;
  existing: Sortie[];
  waypoints: Waypoint[];
  assets: ImageAsset[];
  route: RouteParamSig;
}): ReplanResult {
  const { missionId, existing, waypoints, assets, route } = params;
  const now = Date.now();
  const sig = routeParamsSig(route);
  const wpSig = waypointFingerprint(waypoints);

  const kept: Sortie[] = [];
  const removedIds: string[] = [];
  const keptRange = new Set<number>();
  const removedRange = new Set<number>();
  existing.forEach((s) => {
    if (isSortieLocked(s)) {
      kept.push(s);
      waypoints.forEach((w) => {
        if (w.seq >= s.wpStartSeq && w.seq <= s.wpEndSeq) keptRange.add(w.seq);
      });
    } else {
      removedIds.push(s.id);
      waypoints.forEach((w) => {
        if (w.seq >= s.wpStartSeq && w.seq <= s.wpEndSeq) removedRange.add(w.seq);
      });
    }
  });

  // 需要重新划分的航点：不在任何已编目（保留）架次区间内
  const coveredWps = waypoints.filter((w) => !keptRange.has(w.seq)).sort((a, b) => a.seq - b.seq);
  const startNo = kept.length === 0 ? 1 : Math.max(...kept.map((s) => s.sortieNo)) + 1;
  const planned: PlannedSortieSeed[] = planWaypointSorties(coveredWps, route, startNo);
  const created: Sortie[] = planned.map((seed) => ({
    id: newId('sortie'),
    missionId,
    sortieNo: seed.sortieNo,
    wpStartSeq: seed.wpStartSeq,
    wpEndSeq: seed.wpEndSeq,
    estPhotos: seed.estPhotos,
    estDurationMin: seed.estDurationMin,
    status: 'unflown',
    altitude: route.altitude,
    speed: route.speed,
    overlapForward: route.overlapForward,
    overlapSide: route.overlapSide,
    heading: route.heading,
    paramsSig: sig,
    waypointSig: wpSig,
    plannedAt: now,
    updatedAt: now,
  }));

  const sorties = [...kept, ...created].sort((a, b) => a.sortieNo - b.sortieNo);
  const removedIdSet = new Set(removedIds);

  // 受影响影像：直连在作废架次上，或匹配航点落进重划区（原属保留架次的除外）
  const matches = matchAssetsToWaypoints(assets, waypoints);
  const assetPatches: ReplanResult['assetPatches'] = [];
  const reviewAssetIds: string[] = [];
  assets.forEach((asset) => {
    const m = matches.get(asset.id);
    const wp = m?.matched ? m.waypoint : asset.waypointId ? waypoints.find((w) => w.id === asset.waypointId) : undefined;
    const directRemoved = !!asset.sortieId && removedIdSet.has(asset.sortieId);
    const fellIntoReplanned =
      !!wp && !keptRange.has(wp.seq) && (directRemoved || removedRange.has(wp.seq) || !!asset.sortieId);
    if (!directRemoved && !fellIntoReplanned) return;

    const target = wp ? sorties.find((s) => wp.seq >= s.wpStartSeq && wp.seq <= s.wpEndSeq) : undefined;
    assetPatches.push({
      id: asset.id,
      patch: {
        needsReview: true,
        sortieId: target?.id,
        waypointId: m?.matched && m.waypoint ? m.waypoint.id : asset.waypointId,
      },
    });
    reviewAssetIds.push(asset.id);
  });

  return { sorties, removedSortieIds: removedIds, assetPatches, reviewAssetIds };
}
