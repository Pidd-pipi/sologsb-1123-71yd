/** 架次状态 */
export type SortieStatus = '待飞' | '已飞' | '漏拍';

export const SORTIE_STATUSES: SortieStatus[] = ['待飞', '已飞', '漏拍'];

/** 架次：按续航把一条航线拆成若干架次，每架次记录航点范围与预计张数 */
export interface Sortie {
  id: string;
  missionId: string;
  /** 架次号 */
  sortieNo: number;
  /** 起始航点 seq（含） */
  fromSeq: number;
  /** 结束航点 seq（含） */
  toSeq: number;
  /** 本架次预计张数 */
  estPhotos: number;
  /** 本架次预计耗时 min */
  estDuration: number;
  status: SortieStatus;
  /** 依据的相对航高 m（参数快照） */
  altitude: number;
  /** 依据的航向重叠率 % */
  overlapForward: number;
  /** 依据的旁向重叠率 % */
  overlapSide: number;
  /** 依据的航带方向 ° */
  heading: number;
  /** 依据的 GSD cm/px */
  gsd: number;
  /** 依据的航线间距 m */
  spacing: number;
  /** 依据的拍照间隔 m */
  photoInterval: number;
  /** 依据的预计总张数（快照） */
  estPhotosTotal: number;
  /** 依据的预计总耗时（快照） */
  estDurationTotal: number;
  /** 依据的电池组数（快照） */
  batteryCount: number;
  createdAt: number;
  /** 参数变化导致失效的时间戳 */
  invalidatedAt?: number;
}

export type SortieDraft = Omit<Sortie, 'id' | 'createdAt'>;
