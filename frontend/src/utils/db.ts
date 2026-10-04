import Dexie, { type Table } from 'dexie';
import type { CameraPreset, Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset } from '../types/imageasset';
import {
  planWaypointSorties,
  routeParamsSig,
  waypointFingerprint,
  type RouteParamSig,
  type Sortie,
} from '../types/sortie';
import { newId } from './id';
import { matchAssetsToWaypoints } from './sortieReconcile';

export const DB_NAME = 'gbdronemap';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbdronemap:db-version';

class DroneMapDB extends Dexie {
  missions!: Table<Mission, string>;
  waypoints!: Table<Waypoint, string>;
  lines!: Table<FlightLine, string>;
  assets!: Table<ImageAsset, string>;
  thumbs!: Table<AssetThumb, string>;
  presets!: Table<CameraPreset, string>;
  sorties!: Table<Sortie, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, createdAt',
      waypoints: 'id, missionId, seq, action',
      lines: 'id, missionId, lineNo',
      assets: 'id, missionId, imageNo, quality',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
    });
    this.version(2)
      .stores({
        missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
        waypoints: 'id, missionId, seq, action, altitude',
        lines: 'id, missionId, lineNo, updatedAt',
        assets: 'id, missionId, imageNo, quality, shotAt',
        thumbs: 'id, missionId',
        presets: 'id, name, cameraModel',
      })
      .upgrade(async (tx) => {
        await tx
          .table('missions')
          .toCollection()
          .modify((row: any) => {
            if (!row.areaPolygon) row.areaPolygon = [];
            if (row.sensorWidth === undefined) row.sensorWidth = 13.2;
            if (row.sensorHeight === undefined) row.sensorHeight = 8.8;
            if (row.focalLength === undefined) row.focalLength = 8.8;
            if (row.pixelSize === undefined) row.pixelSize = 2.4;
          });
        await tx
          .table('lines')
          .toCollection()
          .modify((row: any) => {
            if (row.updatedAt === undefined) row.updatedAt = Date.now();
            if (row.batteryCount === undefined) row.batteryCount = 1;
          });
      });
    // v3：架次对账——新增 sorties 表，assets 挂 waypointId/sortieId/needsReview，lines 存参数签名
    this.version(3).stores({
      missions: 'id, missionNo, areaName, droneModel, flightDate, status, purpose, createdAt',
      waypoints: 'id, missionId, seq, action, altitude',
      lines: 'id, missionId, lineNo, updatedAt',
      assets: 'id, missionId, imageNo, quality, shotAt, sortieId, waypointId, needsReview',
      thumbs: 'id, missionId',
      presets: 'id, name, cameraModel',
      sorties: 'id, missionId, sortieNo, status, plannedAt',
    });
  }
}

export const db = new DroneMapDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 读取某任务的航线参数（每任务一条） */
export async function loadFlightLine(missionId: string): Promise<FlightLine | undefined> {
  const rows = await db.lines.where('missionId').equals(missionId).toArray();
  return rows.sort((a, b) => a.lineNo - b.lineNo)[0];
}

/** 保存 / 更新航线参数 */
export async function saveFlightLine(line: FlightLine): Promise<void> {
  await db.lines.put(line);
}

/** 读取某任务的全部架次（按架次号排序） */
export async function loadSorties(missionId: string): Promise<Sortie[]> {
  const rows = await db.sorties.where('missionId').equals(missionId).toArray();
  return rows.sort((a, b) => a.sortieNo - b.sortieNo);
}

/** 读取全部架次 */
export async function loadAllSorties(): Promise<Sortie[]> {
  const rows = await db.sorties.toArray();
  return rows.sort((a, b) => (a.missionId === b.missionId ? a.sortieNo - b.sortieNo : a.missionId.localeCompare(b.missionId)));
}

/**
 * 保存航线参数时分架次：整体替换某任务的架次划分，
 * 同时更新受影响影像的 waypointId/sortieId/needsReview，删除作废架次。
 */
export async function replaceMissionSorties(
  missionId: string,
  next: Sortie[],
  removedSortieIds: string[],
  assetPatches: { id: string; patch: Partial<ImageAsset> }[],
): Promise<void> {
  await db.transaction('rw', [db.sorties, db.assets], async () => {
    if (removedSortieIds.length > 0) await db.sorties.bulkDelete(removedSortieIds);
    await db.sorties.bulkPut(next.filter((s) => s.missionId === missionId));
    for (const { id, patch } of assetPatches) {
      await db.assets.update(id, patch);
    }
  });
}

/** 删除任务时连带删除其架次 */
export async function deleteSortiesByMission(missionId: string): Promise<void> {
  const rows = await db.sorties.where('missionId').equals(missionId).primaryKeys();
  await db.sorties.bulkDelete(rows);
}

export interface LegacyBackfillResult {
  created: Sortie[];
  /** 补上 waypointId/sortieId 归属的影像更新 */
  assetPatches: { id: string; patch: Partial<ImageAsset> }[];
}

/**
 * 旧数据没有架次时兼容：按已有影像的航点补上归属。
 * - 有航点：按续航划分；挂到影像的架次标 flown，其余 unflown；
 * - 无航点但有影像：整任务 1 个补录架次（legacy），影像全挂进去；
 * - 影像坐标就近匹配航点，同时回填 waypointId/sortieId。
 */
export async function backfillMissionSorties(missionId: string): Promise<LegacyBackfillResult> {
  const existing = await db.sorties.where('missionId').equals(missionId).count();
  if (existing > 0) return { created: [], assetPatches: [] };
  const [line, waypoints, assets] = await Promise.all([
    loadFlightLine(missionId),
    db.waypoints.where('missionId').equals(missionId).toArray(),
    db.assets.where('missionId').equals(missionId).toArray(),
  ]);
  const now = Date.now();
  const route: RouteParamSig = {
    altitude: line?.altitude ?? waypoints[0]?.altitude ?? 120,
    speed: line?.speed ?? waypoints[0]?.speed ?? 8,
    overlapForward: line?.overlapForward ?? 75,
    overlapSide: line?.overlapSide ?? 70,
    heading: line?.heading ?? 90,
  };
  const sig = routeParamsSig(route);
  const wpSig = waypointFingerprint(waypoints);

  let seeds = planWaypointSorties(waypoints, route, 1);
  if (seeds.length === 0 && assets.length > 0) {
    seeds = [{ sortieNo: 1, wpStartSeq: 0, wpEndSeq: 0, estPhotos: assets.length, estDurationMin: 0 }];
  }
  if (seeds.length === 0) return { created: [], assetPatches: [] };

  const matches = matchAssetsToWaypoints(assets, waypoints);
  const created: Sortie[] = seeds.map((seed) => {
    const id = newId('sortie');
    const isLegacyBucket = seed.wpStartSeq === 0 && seed.wpEndSeq === 0;
    const hasAsset =
      assets.length > 0 &&
      (isLegacyBucket
        ? true // 无航点补录架次：只要有影像就算已编目
        : assets.some((a) => {
            const m = matches.get(a.id);
            return !!m?.matched && !!m.waypoint && m.waypoint.seq >= seed.wpStartSeq && m.waypoint.seq <= seed.wpEndSeq;
          }));
    return {
      id,
      missionId,
      sortieNo: seed.sortieNo,
      wpStartSeq: seed.wpStartSeq,
      wpEndSeq: seed.wpEndSeq,
      estPhotos: seed.estPhotos,
      estDurationMin: seed.estDurationMin,
      status: hasAsset ? ('flown' as const) : ('unflown' as const),
      altitude: route.altitude,
      speed: route.speed,
      overlapForward: route.overlapForward,
      overlapSide: route.overlapSide,
      heading: route.heading,
      paramsSig: sig,
      waypointSig: wpSig,
      legacy: true,
      plannedAt: now,
      updatedAt: now,
    };
  });

  const assetPatches: LegacyBackfillResult['assetPatches'] = [];
  assets.forEach((asset) => {
    const m = matches.get(asset.id);
    const target =
      created.find((s) => {
        if (s.wpStartSeq === 0 && s.wpEndSeq === 0) return true;
        return !!m?.matched && !!m.waypoint && m.waypoint.seq >= s.wpStartSeq && m.waypoint.seq <= s.wpEndSeq;
      }) ?? created[0];
    const patch: Partial<ImageAsset> = { sortieId: target?.id };
    if (m?.matched && m.waypoint && !asset.waypointId) patch.waypointId = m.waypoint.id;
    if (patch.sortieId || patch.waypointId) assetPatches.push({ id: asset.id, patch });
  });

  await db.transaction('rw', [db.sorties, db.assets], async () => {
    await db.sorties.bulkPut(created);
    for (const { id, patch } of assetPatches) {
      await db.assets.update(id, patch);
    }
  });

  return { created, assetPatches };
}

/** 首次进入灌入示范任务、航点、航线参数、架次与成果影像条目 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.missions.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;

  const missionA = newId('mission');
  const missionB = newId('mission');

  const polygonA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  const polygonB: [number, number][] = [
    [121.4726, 31.2321],
    [121.4789, 31.2334],
    [121.4796, 31.2288],
  ];

  const missions: Mission[] = [
    {
      id: missionA,
      missionNo: 'DM-2024-018',
      name: '中心城区正射影像采集',
      areaName: '北京东城测区',
      areaPolygon: polygonA,
      purpose: '正射',
      droneModel: 'Mavic 3E',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
      flightDate: '2024-09-12',
      pilot: '穆清和',
      status: '已飞行',
      createdAt: now - 30 * day,
    },
    {
      id: missionB,
      missionNo: 'DM-2024-021',
      name: '滨江带状倾斜摄影',
      areaName: '上海浦东滨江带',
      areaPolygon: polygonB,
      purpose: '带状',
      droneModel: 'M300 RTK',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
      flightDate: '2024-09-20',
      pilot: '纪长风',
      status: '待飞行',
      createdAt: now - 8 * day,
    },
  ];

  const waypoints: Waypoint[] = [];
  // 示范任务 A：前 3 点拍照、末点悬停（用于演示「悬停航点不计张数、第 3 拍照点漏拍」）
  const wpsA: [number, number][] = [
    [116.3912, 39.9075],
    [116.3978, 39.9075],
    [116.3978, 39.9032],
    [116.3912, 39.9032],
  ];
  wpsA.forEach(([lng, lat], index) => {
    waypoints.push({
      id: newId('wp'),
      missionId: missionA,
      seq: index + 1,
      lng,
      lat,
      altitude: 120,
      speed: 8,
      heading: 90,
      gimbalPitch: -90,
      action: index === wpsA.length - 1 ? '悬停' : '拍照',
      hoverSec: index === wpsA.length - 1 ? 5 : 0,
    });
  });
  const wpB: Waypoint = {
    id: newId('wp'),
    missionId: missionB,
    seq: 1,
    lng: 121.4726,
    lat: 31.2321,
    altitude: 150,
    speed: 10,
    heading: 45,
    gimbalPitch: -60,
    action: '拍照',
    hoverSec: 0,
  };
  waypoints.push(wpB);

  const wpsARecords = waypoints.filter((w) => w.missionId === missionA).sort((a, b) => a.seq - b.seq);

  const lines: FlightLine[] = [
    {
      id: newId('line'),
      missionId: missionA,
      lineNo: 1,
      spacing: 62.5,
      photoInterval: 24.8,
      overlapForward: 75,
      overlapSide: 70,
      gsd: 3.22,
      estPhotos: 3,
      estDuration: 1.2,
      batteryCount: 1,
      heading: 90,
      altitude: 120,
      speed: 8,
      paramsSig: routeParamsSig({ altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70, heading: 90 }),
      updatedAt: now - 30 * day,
    },
    {
      id: newId('line'),
      missionId: missionB,
      lineNo: 1,
      spacing: 92.3,
      photoInterval: 42.1,
      overlapForward: 70,
      overlapSide: 65,
      gsd: 1.89,
      estPhotos: 1,
      estDuration: 0.1,
      batteryCount: 1,
      heading: 45,
      altitude: 150,
      speed: 10,
      paramsSig: routeParamsSig({ altitude: 150, speed: 10, overlapForward: 70, overlapSide: 65, heading: 45 }),
      updatedAt: now - 8 * day,
    },
  ];

  // 架次：任务 A 单架次（航点 #1~#4，预计 3 张），任务 B 单架次未飞（航点 #1，预计 1 张）
  const sortieAId = newId('sortie');
  const sortieBId = newId('sortie');
  const routeA: RouteParamSig = { altitude: 120, speed: 8, overlapForward: 75, overlapSide: 70, heading: 90 };
  const routeB: RouteParamSig = { altitude: 150, speed: 10, overlapForward: 70, overlapSide: 65, heading: 45 };
  const sorties: Sortie[] = [
    {
      id: sortieAId,
      missionId: missionA,
      sortieNo: 1,
      wpStartSeq: 1,
      wpEndSeq: 4,
      estPhotos: 3,
      estDurationMin: planWaypointSorties(wpsARecords, routeA)[0]?.estDurationMin ?? 1.2,
      status: 'flown',
      altitude: 120,
      speed: 8,
      overlapForward: 75,
      overlapSide: 70,
      heading: 90,
      paramsSig: routeParamsSig(routeA),
      waypointSig: waypointFingerprint(wpsARecords),
      plannedAt: now - 30 * day,
      updatedAt: now - 30 * day,
    },
    {
      id: sortieBId,
      missionId: missionB,
      sortieNo: 1,
      wpStartSeq: 1,
      wpEndSeq: 1,
      estPhotos: 1,
      estDurationMin: planWaypointSorties([wpB], routeB)[0]?.estDurationMin ?? 0.1,
      status: 'unflown',
      altitude: 150,
      speed: 10,
      overlapForward: 70,
      overlapSide: 65,
      heading: 45,
      paramsSig: routeParamsSig(routeB),
      waypointSig: waypointFingerprint([wpB]),
      plannedAt: now - 8 * day,
      updatedAt: now - 8 * day,
    },
  ];

  const assets: ImageAsset[] = [];
  const thumbs: AssetThumb[] = [];
  // 6 张示范影像：#1 航点 3 张（其中一张列待复核）、#2 航点 3 张；#3 拍照航点无影像 → 漏拍
  const wp1 = wpsARecords[0];
  const wp2 = wpsARecords[1];
  const shotPlan: { wp: Waypoint; offset: number; quality: ImageAsset['quality']; review?: boolean }[] = [
    { wp: wp1, offset: 0, quality: '合格' },
    { wp: wp1, offset: 0.00004, quality: '合格' },
    { wp: wp1, offset: 0.00008, quality: '模糊', review: true },
    { wp: wp2, offset: 0, quality: '合格' },
    { wp: wp2, offset: 0.00004, quality: '合格' },
    { wp: wp2, offset: 0.00008, quality: '过曝' },
  ];
  shotPlan.forEach((plan, index) => {
    const id = newId('asset');
    const lng = Number((plan.wp.lng + plan.offset).toFixed(6));
    const lat = plan.wp.lat;
    assets.push({
      id,
      missionId: missionA,
      imageNo: `IMG_${String(1001 + index)}`,
      lng,
      lat,
      altitude: 120,
      gsd: 3.22,
      overlap: 76 - index,
      tiltAngle: 2 + index,
      shotAt: now - 30 * day + index * 12000,
      quality: plan.quality,
      folder: `/DM-2024-018/100MEDIA`,
      waypointId: plan.wp.id,
      sortieId: sortieAId,
      needsReview: !!plan.review,
    });
    thumbs.push({ id, missionId: missionA, dataUrl: makeThumbDataUrl(`IMG_${1001 + index}`, plan.quality, lng, lat) });
  });

  const presets: CameraPreset[] = [
    {
      id: newId('preset'),
      name: 'Mavic 3E 广角',
      cameraModel: 'DJI 4/3 CMOS 20MP',
      sensorWidth: 17.3,
      sensorHeight: 13,
      focalLength: 12.29,
      pixelSize: 3.3,
    },
    {
      id: newId('preset'),
      name: 'Zenmuse P1 35mm',
      cameraModel: 'Zenmuse P1',
      sensorWidth: 35.9,
      sensorHeight: 24,
      focalLength: 35,
      pixelSize: 4.4,
    },
    {
      id: newId('preset'),
      name: 'Phantom 4 RTK',
      cameraModel: 'FC6310R',
      sensorWidth: 13.2,
      sensorHeight: 8.8,
      focalLength: 8.8,
      pixelSize: 2.4,
    },
  ];

  // 七张表超过 Dexie 位置参数上限，改用数组形式声明事务范围
  await db.transaction(
    'rw',
    [db.missions, db.waypoints, db.lines, db.assets, db.thumbs, db.presets, db.sorties],
    async () => {
      await db.missions.bulkPut(missions);
      await db.waypoints.bulkPut(waypoints);
      await db.lines.bulkPut(lines);
      await db.sorties.bulkPut(sorties);
      await db.assets.bulkPut(assets);
      await db.thumbs.bulkPut(thumbs);
      await db.presets.bulkPut(presets);
    },
  );
}
