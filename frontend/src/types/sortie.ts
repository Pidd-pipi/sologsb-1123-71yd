import type { Waypoint } from './waypoint';

/** 架次状态：已编目（挂过影像）/ 未飞 */
export type SortieStatus = 'flown' | 'unflown';

/** 对账结论：齐 / 漏拍（张数不足或航点无影像）/ 未飞 */
export type ReconcileStatus = 'ok' | 'short' | 'unflown';

/** 每组电池有效续航 min（架次拆分上限） */
export const SORTIE_ENDURANCE_MIN = 20;

/** 影像与航点自动配对的最大距离 m，超出视为未匹配 */
export const ASSET_WP_MATCH_TOLERANCE_M = 30;

/** 参与架次划分签名的航线参数（航高/重叠率变化即失效，航速/航带方向一并纳入） */
export interface RouteParamSig {
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

/** 架次：一次电池续航内的一段航点 */
export interface Sortie {
  id: string;
  missionId: string;
  /** 架次号（任务内从 1 起） */
  sortieNo: number;
  /** 起始航点序号 */
  wpStartSeq: number;
  /** 结束航点序号 */
  wpEndSeq: number;
  /** 预计张数（区间内拍照航点数） */
  estPhotos: number;
  /** 预计耗时 min */
  estDurationMin: number;
  status: SortieStatus;
  /** 划分时采用的航高 m */
  altitude: number;
  /** 划分时采用的航速 m/s */
  speed: number;
  /** 划分时采用的航向重叠率 % */
  overlapForward: number;
  /** 划分时采用的旁向重叠率 % */
  overlapSide: number;
  /** 划分时采用的航带方向 ° */
  heading: number;
  /** 航线参数签名：航高/重叠率等一改即与当前参数不一致 */
  paramsSig: string;
  /** 航点指纹：航点增删/换位后与当前航点不一致 */
  waypointSig: string;
  /** 旧数据无架次、按已有影像补出来的归属 */
  legacy?: boolean;
  plannedAt: number;
  updatedAt: number;
}

/** 航线参数签名：参数一改签名即变，架次划分随之失效 */
export function routeParamsSig(params: RouteParamSig): string {
  return [
    `h${Math.round(params.altitude)}`,
    `v${Math.round(params.speed * 10) / 10}`,
    `of${Math.round(params.overlapForward)}`,
    `os${Math.round(params.overlapSide)}`,
    `hd${Math.round(params.heading)}`,
  ].join('|');
}

/** 航点指纹：航点数量、id↔序号对应（增删/换位）、位置/动作序列或总航程变化都会变 */
export function waypointFingerprint(waypoints: Waypoint[]): string {
  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  // 简单 djb2：id + 序号 + 经纬度（6 位）+ 动作；换序即 id 拿到不同序号，指纹随之改变
  let hash = 5381;
  const body = sorted
    .map((w) => `${w.id}@${w.seq}:${w.lng.toFixed(6)},${w.lat.toFixed(6)},${w.action}`)
    .join(';');
  for (let i = 0; i < body.length; i += 1) {
    hash = ((hash << 5) + hash + body.charCodeAt(i)) | 0;
  }
  return `n${sorted.length}|h${hash}`;
}

/** 拆分结果（不含持久化字段） */
export interface PlannedSortieSeed {
  sortieNo: number;
  wpStartSeq: number;
  wpEndSeq: number;
  estPhotos: number;
  estDurationMin: number;
}

function edgeDurationSec(from: Waypoint | undefined, to: Waypoint): number {
  if (!from) return 0;
  const dx = (to.lng - from.lng) * 111320 * Math.cos((from.lat * Math.PI) / 180);
  const dy = (to.lat - from.lat) * 111320;
  const dist = Math.hypot(dx, dy);
  return paramsSpeedSafe(to.speed) > 0 ? dist / to.speed : 0;
}

function paramsSpeedSafe(speed: number): number {
  return speed > 0 ? speed : 8;
}

/**
 * 按电池续航把航点序列贪心切成架次：
 * 逐点累计「航程/航速 + 每点转弯 4s + 悬停秒数」，超过 20min 就另起一架次，
 * 每架次至少含 1 个航点。预计张数取区间内「拍照」航点数。
 */
export function planWaypointSorties(
  waypoints: Waypoint[],
  params: RouteParamSig,
  startNo = 1,
): PlannedSortieSeed[] {
  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) return [];

  const speed = paramsSpeedSafe(params.speed);
  const photoCount = (a: number, b: number) =>
    sorted.filter((w) => w.seq >= a && w.seq <= b && w.action === '拍照').length;

  const seeds: PlannedSortieSeed[] = [];
  let cursor = 0;
  let no = startNo;
  while (cursor < sorted.length) {
    const start = cursor;
    let elapsedSec = 0;
    let end = cursor;
    for (let i = cursor; i < sorted.length; i += 1) {
      const prev = i === start ? undefined : sorted[i - 1];
      const wp = sorted[i];
      const cost = edgeDurationSec(prev, { ...wp, speed }) + 4 + (wp.action === '悬停' ? wp.hoverSec : 0);
      // 非首点且放入后超出续航 → 先封当前架次
      if (i > start && (elapsedSec + cost) / 60 > SORTIE_ENDURANCE_MIN) break;
      elapsedSec += cost;
      end = i;
    }
    const a = sorted[start].seq;
    const b = sorted[end].seq;
    const photos = photoCount(a, b);
    seeds.push({
      sortieNo: no,
      wpStartSeq: a,
      wpEndSeq: b,
      estPhotos: photos,
      estDurationMin: Math.round((elapsedSec / 60) * 10) / 10,
    });
    no += 1;
    cursor = end + 1;
  }
  return seeds;
}
