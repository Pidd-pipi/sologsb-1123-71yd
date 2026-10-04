import { useMemo } from 'react';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import { reconcileSorties, type SortieReconcile } from '../utils/sortieReconcile';
import { routeParamsSig, waypointFingerprint, type Sortie } from '../types/sortie';
import type { ImageAsset } from '../types/imageasset';
import type { RouteParamSig } from '../types/sortie';
import type { Waypoint } from '../types/waypoint';

export interface MissionReconcile {
  sorties: Sortie[];
  rows: SortieReconcile[];
  unassignedAssets: ImageAsset[];
  unassignedWaypoints: Waypoint[];
  /** 漏拍架次数 */
  shortCount: number;
  /** 缺拍总张数 */
  missingCount: number;
  /** 待复核影像数 */
  reviewCount: number;
  /** 当前参数与保存时不一致：航高/重叠率已改，架次划分失效待重算 */
  stale: boolean;
  /** 已编目（锁定）架次数 */
  flownCount: number;
}

/**
 * 任务级架次对账：影像按航点归架次，张数不足/航点无影像判漏拍，
 * 并比较参数签名/航点指纹判断划分是否已失效。
 */
export function useSortieReconcile(missionId: string | undefined, currentParams?: RouteParamSig): MissionReconcile {
  const sorties = useSortieStore((s) => s.items);
  const allWaypoints = useWaypointStore((s) => s.items);
  const allAssets = useAssetStore((s) => s.items);

  return useMemo<MissionReconcile>(() => {
    const missionSorties = sorties
      .filter((s) => s.missionId === missionId)
      .sort((a, b) => a.sortieNo - b.sortieNo);
    const waypoints = allWaypoints
      .filter((w) => w.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
    const assets = allAssets.filter((a) => a.missionId === missionId);

    const { rows, unassignedAssets, unassignedWaypoints } = reconcileSorties(missionSorties, waypoints, assets);
    const shortCount = rows.filter((r) => r.status === 'short').length;
    const missingCount = rows.reduce((s, r) => s + (r.status === 'short' ? r.missingCount : 0), 0);
    const reviewCount = assets.filter((a) => a.needsReview).length;
    const flownCount = rows.filter((r) => r.sortie.status === 'flown').length;

    let stale = false;
    if (currentParams && missionSorties.length > 0) {
      const curSig = routeParamsSig(currentParams);
      const curWpSig = waypointFingerprint(waypoints);
      // 任一未飞架次与当前参数/航点不一致即失效；已编目架次不参与失效判定
      stale = missionSorties.some(
        (s: Sortie) => s.status === 'unflown' && (s.paramsSig !== curSig || s.waypointSig !== curWpSig),
      );
    }

    return { sorties: missionSorties, rows, unassignedAssets, unassignedWaypoints, shortCount, missingCount, reviewCount, stale, flownCount };
  }, [sorties, allWaypoints, allAssets, missionId, currentParams]);
}
