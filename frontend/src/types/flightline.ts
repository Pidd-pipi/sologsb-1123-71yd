/** 航线参数 */
export interface FlightLine {
  id: string;
  missionId: string;
  /** 航线号 */
  lineNo: number;
  /** 航线间距 m */
  spacing: number;
  /** 拍照间隔 m */
  photoInterval: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 地面分辨率 cm/px */
  gsd: number;
  /** 预计张数 */
  estPhotos: number;
  /** 预计耗时 min */
  estDuration: number;
  /** 预计电池组数 */
  batteryCount: number;
  /** 航带方向 ° */
  heading: number;
  /** 保存时采用的相对航高 m（用于航高变化判定） */
  altitude?: number;
  /** 保存时采用的航速 m/s */
  speed?: number;
  /** 航线参数签名：航高/重叠率变化后与当前参数不一致即失效 */
  paramsSig?: string;
  updatedAt: number;
}

export type FlightLineDraft = Omit<FlightLine, 'id' | 'updatedAt'>;
