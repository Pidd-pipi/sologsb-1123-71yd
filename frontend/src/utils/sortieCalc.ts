import type { Waypoint } from '../types/waypoint';
import type { ImageAsset } from '../types/imageasset';
import type { Sortie, SortieDraft, SortieStatus } from '../types/sortie';
import { distanceMeters } from './geoCalc';
import { round } from './id';

/** 每组电池有效续航 min（与 db.splitSorties 保持一致） */
export const PER_SORTIE_MINUTES = 20;

/** 影像归属航点的判定阈值 m：超过该距离视为无主影像 */
export const IMAGE_WAYPOINT_THRESHOLD_M = 80;

export interface SortieSplit {
  sortieNo: number;
  fromSeq: number;
  toSeq: number;
  estPhotos: number;
  estDuration: number;
}

/**
 * 按续航把航点均匀拆成 N 个架次，记录航点范围与预计张数。
 * N = ceil(estDuration / 20)；航点按顺序尽量均分，余数摊到前几个架次。
 */
export function splitWaypointsToSorties(
  waypoints: Waypoint[],
  estPhotos: number,
  estDuration: number,
  perSortieMin: number = PER_SORTIE_MINUTES,
): SortieSplit[] {
  const count = Math.max(1, Math.ceil(estDuration / perSortieMin));
  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  const W = sorted.length;
  const base = W > 0 ? Math.floor(W / count) : 0;
  const remainder = W > 0 ? W % count : 0;
  const photosPer = Math.ceil(estPhotos / count);
  const durationPer = round(estDuration / count, 1);

  const result: SortieSplit[] = [];
  let offset = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    const from = sorted[offset];
    const to = sorted[offset + size - 1];
    result.push({
      sortieNo: i + 1,
      fromSeq: from?.seq ?? 0,
      toSeq: to?.seq ?? 0,
      estPhotos: photosPer,
      estDuration: durationPer,
    });
    offset += size;
  }
  return result;
}

/** 找影像最近的航点 seq（超过阈值返回 undefined） */
export function nearestWaypointSeq(
  lng: number,
  lat: number,
  waypoints: Waypoint[],
  thresholdM: number = IMAGE_WAYPOINT_THRESHOLD_M,
): number | undefined {
  let best: Waypoint | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  waypoints.forEach((w) => {
    const d = distanceMeters([lng, lat], [w.lng, w.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = w;
    }
  });
  if (!best || bestDist > thresholdM) return undefined;
  return best.seq;
}

/** 把影像归到航点范围包含它的架次 */
export function assignImageToSortie(
  asset: ImageAsset,
  waypoints: Waypoint[],
  sorties: Sortie[],
): Sortie | undefined {
  const seq = nearestWaypointSeq(asset.lng, asset.lat, waypoints);
  if (seq === undefined) return undefined;
  return sorties.find((s) => seq >= s.fromSeq && seq <= s.toSeq);
}

export interface ReconciledSortie extends Sortie {
  /** 实际影像张数 */
  actualPhotos: number;
  /** 范围内的航点数 */
  waypointCount: number;
  /** 已有影像的航点 seq 集合 */
  coveredSeqs: number[];
  /** 漏拍航点 seq 列表 */
  missedSeqs: number[];
}

/**
 * 架次对账：按航点范围统计实际影像张数与漏拍航点。
 * - 张数不足（actualPhotos < estPhotos）或存在无影像航点 → 漏拍
 * - 无影像且无航点覆盖 → 待飞
 * - 其余 → 已飞
 */
export function reconcileSorties(sorties: Sortie[], waypoints: Waypoint[], assets: ImageAsset[]): ReconciledSortie[] {
  const sortedWps = [...waypoints].sort((a, b) => a.seq - b.seq);
  return sorties.map((s) => {
    const inRange = sortedWps.filter((w) => w.seq >= s.fromSeq && w.seq <= s.toSeq);
    const assigned = assets.filter((a) => {
      const seq = nearestWaypointSeq(a.lng, a.lat, sortedWps);
      return seq !== undefined && seq >= s.fromSeq && seq <= s.toSeq;
    });
    const coveredSeqs = new Set<number>();
    assigned.forEach((a) => {
      const seq = nearestWaypointSeq(a.lng, a.lat, sortedWps);
      if (seq !== undefined) coveredSeqs.add(seq);
    });
    const missedSeqs = inRange.map((w) => w.seq).filter((seq) => !coveredSeqs.has(seq));
    const actualPhotos = assigned.length;
    let status: SortieStatus = '已飞';
    if (actualPhotos === 0 && inRange.length === 0) {
      status = '待飞';
    } else if (actualPhotos < s.estPhotos || missedSeqs.length > 0) {
      status = '漏拍';
    }
    return {
      ...s,
      status,
      actualPhotos,
      waypointCount: inRange.length,
      coveredSeqs: Array.from(coveredSeqs).sort((a, b) => a - b),
      missedSeqs,
    };
  });
}

/** 由拆分结果 + 参数快照生成架次草稿 */
export function buildSortieDrafts(
  splits: SortieSplit[],
  missionId: string,
  snapshot: {
    altitude: number;
    overlapForward: number;
    overlapSide: number;
    heading: number;
    gsd: number;
    spacing: number;
    photoInterval: number;
    estPhotosTotal: number;
    estDurationTotal: number;
    batteryCount: number;
  },
): SortieDraft[] {
  return splits.map((sp) => ({
    missionId,
    sortieNo: sp.sortieNo,
    fromSeq: sp.fromSeq,
    toSeq: sp.toSeq,
    estPhotos: sp.estPhotos,
    estDuration: sp.estDuration,
    status: '待飞',
    altitude: snapshot.altitude,
    overlapForward: snapshot.overlapForward,
    overlapSide: snapshot.overlapSide,
    heading: snapshot.heading,
    gsd: snapshot.gsd,
    spacing: snapshot.spacing,
    photoInterval: snapshot.photoInterval,
    estPhotosTotal: snapshot.estPhotosTotal,
    estDurationTotal: snapshot.estDurationTotal,
    batteryCount: snapshot.batteryCount,
  }));
}
