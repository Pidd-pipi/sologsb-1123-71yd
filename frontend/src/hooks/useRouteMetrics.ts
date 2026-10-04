import { useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from '../utils/geoCalc';
import { planWaypointSorties, type PlannedSortieSeed } from '../types/sortie';
import type { LngLat } from '../types/mission';
import type { Waypoint } from '../types/waypoint';

export interface RouteParams {
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 航带方向 ° */
  heading: number;
}

export const DEFAULT_ROUTE_PARAMS: RouteParams = {
  altitude: 120,
  speed: 8,
  overlapForward: 75,
  overlapSide: 70,
  heading: 90,
};

export interface RouteMetrics {
  gsd: number;
  spacing: number;
  photoInterval: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
  coverageForward: number;
  coverageSide: number;
  /** 按续航切出的架次预览（含航点范围与预计张数） */
  sorties: PlannedSortieSeed[];
}

/**
 * 由航高、焦距、像元尺寸算 GSD、航线间距、预计张数与耗时，
 * 并按电池续航把航点序列切成架次（航点范围 + 预计张数）。
 * 被航线规划页（/missions/:id/route）与航点明细页（/missions/:id/waypoints）消费。
 */
export function useRouteMetrics(missionId: string | undefined, params: RouteParams = DEFAULT_ROUTE_PARAMS): RouteMetrics {
  const missions = useMissionStore((s) => s.items);
  const allWaypoints = useWaypointStore((s) => s.items);

  return useMemo<RouteMetrics>(() => {
    const mission = missions.find((m) => m.id === missionId);
    const missionWaypoints: Waypoint[] = allWaypoints
      .filter((w) => w.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
    const points: LngLat[] = missionWaypoints.map((w) => [w.lng, w.lat] as LngLat);

    const sensorWidth = mission?.sensorWidth ?? 13.2;
    const sensorHeight = mission?.sensorHeight ?? 8.8;
    const focalLength = mission?.focalLength ?? 8.8;
    const pixelSize = mission?.pixelSize ?? 2.4;

    const gsd = calcGsd(pixelSize, params.altitude, focalLength);
    const spacing = lineSpacing(sensorWidth, params.altitude, focalLength, params.overlapSide);
    const interval = photoInterval(sensorHeight, params.altitude, focalLength, params.overlapForward);
    const area = mission ? polygonAreaM2(mission.areaPolygon) : 0;
    const pathLength = pathLengthMeters(points);
    // 按测区面积与航线间距估算航带数
    const side = area > 0 ? Math.sqrt(area) : 0;
    const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
    const effLineLength = lineCount > 0 ? (area > 0 ? area / (lineCount * Math.max(spacing, 1)) * spacing : 0) : 0;
    const estPhotosArea = estimatePhotos(effLineLength || side, interval, lineCount);
    const hoverSecTotal = missionWaypoints.reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
    const estDuration = estimateDuration(pathLength, params.speed, points.length, hoverSecTotal);
    const batteryCount = estimateBatteries(estDuration);
    // 按续航 + 航点序列切架次，预计张数取区间内拍照航点数
    const sorties = planWaypointSorties(missionWaypoints, params);
    const estPhotos = sorties.length > 0 ? sorties.reduce((s, x) => s + x.estPhotos, 0) : estPhotosArea;

    return {
      gsd,
      spacing,
      photoInterval: interval,
      estPhotos,
      estDuration,
      batteryCount,
      area,
      pathLength,
      waypointCount: points.length,
      lineCount,
      coverageForward: Math.round((sensorHeight * params.altitude) / (focalLength || 1) * 100) / 100,
      coverageSide: Math.round((sensorWidth * params.altitude) / (focalLength || 1) * 100) / 100,
      sorties,
    };
  }, [missions, allWaypoints, missionId, params]);
}
