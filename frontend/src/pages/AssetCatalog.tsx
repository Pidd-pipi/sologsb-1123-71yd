import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import {
  CameraOutlined,
  CheckCircleOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import AssetGrid from '../components/common/AssetGrid';
import AmapRouteView from '../components/common/AmapRouteView';
import { IMAGE_QUALITIES, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';
import { calcGsd, distanceMeters } from '../utils/geoCalc';
import { matchAssetsToWaypoints } from '../utils/sortieReconcile';
import type { SortieReconcile } from '../utils/sortieReconcile';
import type { Waypoint } from '../types/waypoint';

type ReviewFilter = 'all' | 'review' | 'ok';
type MissingRow = {
  key: string;
  sortieNo: number;
  wpSeq: number;
  lng: number;
  lat: number;
  reason: string;
  waypointId: string;
  sortieId: string;
};

/** /missions/:id/assets 成果影像编目 + 架次对账：按航点归架次，漏拍/待复核一目了然 */
export default function AssetCatalog() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const assets = useAssetStore((s) => s.items);
  const thumbs = useAssetStore((s) => s.thumbs);
  const addMany = useAssetStore((s) => s.addMany);
  const markMany = useAssetStore((s) => s.markMany);
  const clearReview = useAssetStore((s) => s.clearReview);
  const removeMany = useAssetStore((s) => s.removeMany);
  const sorties = useSortieStore((s) => s.items);
  const ensureBackfill = useSortieStore((s) => s.ensureBackfill);
  const markFlown = useSortieStore((s) => s.markFlown);

  const mission = missions.find((m) => m.id === id);
  const missionAssets = useMemo(
    () => assets.filter((a) => a.missionId === id).sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true })),
    [assets, id],
  );
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );
  const missionSorties = useMemo(
    () => sorties.filter((s) => s.missionId === id).sort((a, b) => a.sortieNo - b.sortieNo),
    [sorties, id],
  );

  // 旧数据兼容：进入页面且无架次时，按已有影像的航点补归属
  const [backfilled, setBackfilled] = useState(false);
  useEffect(() => {
    if (!id || backfilled) return;
    let alive = true;
    void ensureBackfill(id).then((n) => {
      if (alive && n > 0) setToast(`检测到旧数据无架次，已按 ${n} 个航点区间补出架次归属`);
      if (alive) setBackfilled(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sorties.length]);

  // 影像 → 航点匹配（用于展示归属与补录）
  const wpMatch = useMemo(
    () => matchAssetsToWaypoints(missionAssets, missionWaypoints),
    [missionAssets, missionWaypoints],
  );
  /** 航点 id → 航点 */
  const wpById = useMemo(() => new Map(missionWaypoints.map((w) => [w.id, w])), [missionWaypoints]);

  /** 影像 → 架次号/航点号标签：sortieId 直连优先，否则按匹配航点区间 */
  const resolveLabel = (asset: ImageAsset): { sortieNo?: number; wpSeq?: number } => {
    const viaSortie = asset.sortieId ? missionSorties.find((s) => s.id === asset.sortieId) : undefined;
    const m = wpMatch.get(asset.id);
    const wp = asset.waypointId ? wpById.get(asset.waypointId) : m?.matched ? m.waypoint : undefined;
    const sortie =
      viaSortie ??
      (wp ? missionSorties.find((s) => wp.seq >= s.wpStartSeq && wp.seq <= s.wpEndSeq) : undefined);
    return { sortieNo: sortie?.sortieNo, wpSeq: wp?.seq };
  };

  const [selected, setSelected] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  const [qualityFilter, setQualityFilter] = useState<ImageQuality | 'all'>('all');
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [sortieFilter, setSortieFilter] = useState<number | 'all' | 'unassigned'>('all');
  const [locateSeq, setLocateSeq] = useState<number | undefined>(undefined);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 架次对账
  const reconcileRows: SortieReconcile[] = useMemo(() => {
    return missionSorties.map((sortie) => {
      const inWps = missionWaypoints.filter((w) => w.seq >= sortie.wpStartSeq && w.seq <= sortie.wpEndSeq);
      const photoWps = inWps.filter((w) => w.action === '拍照');
      const inAssets = missionAssets.filter((a) => {
        if (a.sortieId === sortie.id) return true;
        const m = wpMatch.get(a.id);
        return !!m?.matched && !!m.waypoint && m.waypoint.seq >= sortie.wpStartSeq && m.waypoint.seq <= sortie.wpEndSeq;
      });
      const covered = new Set<string>();
      inAssets.forEach((a) => {
        const m = wpMatch.get(a.id);
        if (m?.matched && m.waypoint && m.waypoint.seq >= sortie.wpStartSeq && m.waypoint.seq <= sortie.wpEndSeq) {
          covered.add(m.waypoint.id);
        }
      });
      const missingWaypoints = photoWps.filter((w) => !covered.has(w.id));
      const missingCount =
        missingWaypoints.length > 0 ? missingWaypoints.length : Math.max(0, sortie.estPhotos - inAssets.length);
      const status = sortie.status === 'unflown' && inAssets.length === 0 ? 'unflown' : missingCount > 0 ? 'short' : 'ok';
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
      } as SortieReconcile;
    });
  }, [missionSorties, missionWaypoints, missionAssets, wpMatch]);

  const shortRows = reconcileRows.filter((r) => r.status === 'short');
  const reviewAssets = missionAssets.filter((a) => a.needsReview);
  const missingTable: MissingRow[] = useMemo(
    () =>
      shortRows.flatMap((r) =>
        r.missingWaypoints.map((w) => ({
          key: `${r.sortie.id}-${w.id}`,
          sortieNo: r.sortie.sortieNo,
          wpSeq: w.seq,
          lng: w.lng,
          lat: w.lat,
          reason: '该拍照航点没有对应影像',
          waypointId: w.id,
          sortieId: r.sortie.id,
        })),
      ),
    [shortRows],
  );

  const assignedAssetIds = useMemo(() => {
    const ids = new Set<string>();
    reconcileRows.forEach((r) => r.assets.forEach((a) => ids.add(a.id)));
    return ids;
  }, [reconcileRows]);

  const filtered = missionAssets.filter((a) => {
    if (qualityFilter !== 'all' && a.quality !== qualityFilter) return false;
    if (reviewFilter === 'review' && !a.needsReview) return false;
    if (reviewFilter === 'ok' && a.needsReview) return false;
    if (keyword && !a.imageNo.toLowerCase().includes(keyword.trim().toLowerCase())) return false;
    if (sortieFilter === 'unassigned') {
      if (assignedAssetIds.has(a.id)) return false;
    } else if (typeof sortieFilter === 'number') {
      const label = resolveLabel(a);
      if (label.sortieNo !== sortieFilter) return false;
    }
    return true;
  });

  const stats = IMAGE_QUALITIES.map((quality) => ({
    quality,
    count: missionAssets.filter((a) => a.quality === quality).length,
  }));

  /** 按航点批量编目：一张拍照航点一张影像，并直接挂 waypointId/sortieId（未飞架次由此转为已飞） */
  const catalogFromWaypoints = async (onlyWaypointIds?: string[]) => {
    if (!mission) return;
    if (missionWaypoints.length === 0) {
      setError('该任务暂无航点，请先到「航点明细」录入或点击网格新增');
      return;
    }
    // 已有影像覆盖的航点不再重复编目
    const coveredWpIds = new Set<string>();
    missionAssets.forEach((a) => {
      const m = wpMatch.get(a.id);
      if (m?.matched && m.waypoint) coveredWpIds.add(m.waypoint.id);
    });
    const targets = missionWaypoints.filter(
      (w) =>
        w.action === '拍照' &&
        (!onlyWaypointIds || onlyWaypointIds.includes(w.id)) &&
        !coveredWpIds.has(w.id),
    );
    if (targets.length === 0) {
      setError(onlyWaypointIds ? '该漏拍航点已补录，无需重复编目' : '所有拍照航点都已有影像，无需重复编目');
      return;
    }
    const startNo = missionAssets.length + 1;
    const drafts: ImageAssetDraft[] = targets.map((w, index) => ({
      missionId: mission.id,
      imageNo: `IMG_${String(2000 + startNo + index)}`,
      lng: w.lng,
      lat: w.lat,
      altitude: w.altitude,
      gsd: calcGsd(mission.pixelSize, w.altitude, mission.focalLength),
      overlap: missionSorties[0]?.overlapForward ?? 75,
      tiltAngle: Math.abs(w.gimbalPitch + 90),
      shotAt: Date.now() + index * 1000,
      quality: '合格' as ImageQuality,
      folder: `/${mission.missionNo}/100MEDIA`,
    }));
    const refs = targets.map((w) => ({
      waypointId: w.id,
      sortieId: missionSorties.find((s) => w.seq >= s.wpStartSeq && w.seq <= s.wpEndSeq)?.id,
      needsReview: false,
    }));
    await addMany(drafts, refs);
    // 挂到影像的架次立即转为已飞并锁定
    const flownIds = Array.from(new Set(refs.map((r) => r.sortieId).filter((x): x is string => !!x)));
    await markFlown(flownIds);
    setError('');
    setToast(`已按 ${targets.length} 个拍照航点编目并归入对应架次`);
  };

  const locate = (asset: ImageAsset) => {
    if (missionWaypoints.length === 0) return;
    const linked = asset.waypointId ? wpById.get(asset.waypointId) : undefined;
    let best: Waypoint | undefined = linked;
    let bestDist = linked ? 0 : Number.POSITIVE_INFINITY;
    if (!linked) {
      missionWaypoints.forEach((w) => {
        const d = distanceMeters([asset.lng, asset.lat], [w.lng, w.lat]);
        if (d < bestDist) {
          bestDist = d;
          best = w;
        }
      });
    }
    if (best) {
      setLocateSeq(best.seq);
      setToast(`已定位到航点 #${best.seq}${linked ? '' : `（就近匹配，距离 ${bestDist.toFixed(1)} m）`}`);
    }
  };

  const locateMissing = (row: MissingRow) => {
    setLocateSeq(row.wpSeq);
    setToast(`漏拍航点 #${row.wpSeq}（第 ${row.sortieNo} 架次）已在图上高亮`);
  };

  const exportList = () => {
    const header = '片号,架次,航点序号,经度,纬度,航高m,GSDcm/px,重叠%,倾角°,质量,待复核,归档目录';
    const lines = missionAssets.map((a) => {
      const label = resolveLabel(a);
      return [
        a.imageNo,
        label.sortieNo ?? '',
        label.wpSeq ?? '',
        a.lng,
        a.lat,
        a.altitude,
        a.gsd,
        a.overlap,
        a.tiltAngle,
        a.quality,
        a.needsReview ? '待复核' : '',
        a.folder,
      ].join(',');
    });
    // 附一段架次对账汇总，保证导出清单与航线参数对得上
    const summary = reconcileRows.map(
      (r) =>
        `#架次${r.sortie.sortieNo},航点#${r.sortie.wpStartSeq}-#${r.sortie.wpEndSeq},预计${r.estCount},实到${r.actualCount},${
          r.status === 'ok' ? '齐' : r.status === 'short' ? `漏拍${r.missingCount}` : '未飞'
        }`,
    );
    const blob = new Blob([[header, ...lines, '', ...summary].join('\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `成果影像清单_${mission?.missionNo ?? 'mission'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${lines.length} 条影像清单（含 ${summary.length} 个架次对账行）`);
  };

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  const sortieColumns: TableProps<SortieReconcile>['columns'] = [
    { title: '架次', dataIndex: ['sortie', 'sortieNo'], width: 80, render: (v: number) => `第 ${v} 架次` },
    {
      title: '航点范围',
      key: 'range',
      width: 120,
      render: (_, r) => `#${r.sortie.wpStartSeq} ~ #${r.sortie.wpEndSeq}`,
    },
    { title: '预计张数', dataIndex: 'estCount', width: 90 },
    { title: '实到张数', dataIndex: 'actualCount', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: SortieReconcile['status']) =>
        v === 'ok' ? (
          <Tag color="green">齐</Tag>
        ) : v === 'short' ? (
          <Tag icon={<ExclamationCircleOutlined />} color="red">
            漏拍
          </Tag>
        ) : (
          <Tag>未飞</Tag>
        ),
    },
    {
      title: '缺拍 / 待复核',
      key: 'issues',
      render: (_, r) => (
        <Space size={4} wrap>
          {r.missingCount > 0 ? <Tag color="red">缺 {r.missingCount} 张</Tag> : null}
          {r.reviewCount > 0 ? <Tag color="orange">待复核 {r.reviewCount}</Tag> : null}
          {r.missingCount === 0 && r.reviewCount === 0 ? <Typography.Text type="secondary">—</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: '备注',
      key: 'legacy',
      width: 130,
      render: (_, r) => (r.sortie.legacy ? <Tag color="purple">旧数据补录</Tag> : '—'),
    },
  ];

  const missingColumns: TableProps<MissingRow>['columns'] = [
    { title: '架次', dataIndex: 'sortieNo', width: 90, render: (v: number) => `第 ${v} 架次` },
    { title: '漏拍航点', dataIndex: 'wpSeq', width: 100, render: (v: number) => `#${v}` },
    { title: '经度', dataIndex: 'lng', render: (v: number) => v.toFixed(6) },
    { title: '纬度', dataIndex: 'lat', render: (v: number) => v.toFixed(6) },
    { title: '原因', dataIndex: 'reason' },
    {
      title: '操作',
      key: 'op',
      width: 180,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" onClick={() => locateMissing(row)}>
            图上定位
          </Button>
          <Button size="small" type="primary" ghost onClick={() => catalogFromWaypoints([row.waypointId])}>
            补录 1 张
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          成果影像编目 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>条目 {missionAssets.length} 张</Tag>
        <Tag color={missionSorties.length > 0 ? 'geekblue' : 'default'}>架次 {missionSorties.length} 个</Tag>
        {shortRows.length > 0 ? <Tag color="red">{shortRows.length} 个架次漏拍</Tag> : null}
        {reviewAssets.length > 0 ? <Tag color="orange">{reviewAssets.length} 张待复核</Tag> : null}
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        {stats.map((s) => (
          <Col span={4} key={s.quality}>
            <Card size="small">
              <Statistic title={`${s.quality}影像`} value={s.count} suffix="张" />
            </Card>
          </Col>
        ))}
        <Col span={4}>
          <Card size="small">
            <Statistic title="架次数" value={missionSorties.length} suffix="个" />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title={<span>漏拍张数</span>}
              value={shortRows.reduce((s, r) => s + r.missingCount, 0)}
              suffix="张"
              valueStyle={{ color: shortRows.length > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="待复核"
              value={reviewAssets.length}
              suffix="张"
              valueStyle={{ color: reviewAssets.length > 0 ? '#d48806' : undefined }}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="架次对账（航点范围 · 预计 vs 实到）">
        {missionSorties.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="该任务还没有架次：到「航线规划」保存航线参数即按续航分架次；旧数据会在进入本页时自动补归属"
          />
        ) : (
          <Table<SortieReconcile>
            rowKey={(r) => r.sortie.id}
            size="small"
            columns={sortieColumns}
            dataSource={reconcileRows}
            pagination={false}
          />
        )}
      </Card>

      {missingTable.length > 0 ? (
        <Card size="small" title={<Space><ExclamationCircleOutlined style={{ color: '#cf1322' }} />漏拍航点（航点无影像 / 张数不足）</Space>}>
          <Table<MissingRow>
            rowKey="key"
            size="small"
            columns={missingColumns}
            dataSource={missingTable}
            pagination={false}
          />
        </Card>
      ) : null}

      <Card size="small">
        <Space wrap size={10}>
          <Input
            allowClear
            style={{ width: 180 }}
            placeholder="按片号筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Select
            style={{ width: 130 }}
            value={qualityFilter}
            onChange={(v) => setQualityFilter(v as ImageQuality | 'all')}
            options={[{ value: 'all', label: '全部质量' }, ...IMAGE_QUALITIES.map((q) => ({ value: q, label: q }))]}
          />
          <Select
            style={{ width: 130 }}
            value={sortieFilter}
            onChange={(v) => setSortieFilter(v as number | 'all' | 'unassigned')}
            options={[
              { value: 'all', label: '全部架次' },
              ...missionSorties.map((s) => ({ value: s.sortieNo, label: `第 ${s.sortieNo} 架次` })),
              { value: 'unassigned', label: '未归架次' },
            ]}
          />
          <Select
            style={{ width: 130 }}
            value={reviewFilter}
            onChange={(v) => setReviewFilter(v as ReviewFilter)}
            options={[
              { value: 'all', label: '全部复核态' },
              { value: 'review', label: '仅待复核' },
              { value: 'ok', label: '仅无需复核' },
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => catalogFromWaypoints()}>
            按航点批量编目
          </Button>
          {missingTable.length > 0 ? (
            <Button
              icon={<CameraOutlined />}
              onClick={() => catalogFromWaypoints(missingTable.map((m) => m.waypointId))}
            >
              一键补录全部漏拍（{missingTable.length}）
            </Button>
          ) : null}
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '合格');
              setToast(`已把 ${selected.length} 张标记为「合格」`);
            }}
          >
            标记合格
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '模糊');
              setToast(`已把 ${selected.length} 张标记为「模糊」`);
            }}
          >
            标记模糊
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={async () => {
              await markMany(selected, '过曝');
              setToast(`已把 ${selected.length} 张标记为「过曝」`);
            }}
          >
            标记过曝
          </Button>
          <Button
            icon={<CheckCircleOutlined />}
            disabled={selected.length === 0}
            onClick={async () => {
              await clearReview(selected);
              setToast(`已把 ${selected.length} 张移出待复核`);
            }}
          >
            标记已复核
          </Button>
          <Button
            danger
            disabled={selected.length === 0}
            onClick={async () => {
              await removeMany(selected);
              setToast(`已删除 ${selected.length} 条影像条目`);
              setSelected([]);
            }}
          >
            删除选中
          </Button>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={missionAssets.length === 0}>
            导出成果清单
          </Button>
        </Space>
      </Card>

      <Row gutter={14}>
        <Col span={16}>
          <Card size="small" title={`影像格子（筛选后 ${filtered.length} 张）`}>
            <AssetGrid
              assets={filtered}
              thumbs={thumbs}
              selectedIds={selected}
              onToggle={(assetId) =>
                setSelected((prev) => (prev.includes(assetId) ? prev.filter((x) => x !== assetId) : [...prev, assetId]))
              }
              onToggleAll={(ids) => setSelected(ids)}
              onLocate={locate}
              resolveLabel={resolveLabel}
            />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small" title="定位到图（漏拍航点红色高亮）">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={missionWaypoints[0]?.altitude ?? 120}
              height={340}
              highlightSeq={locateSeq}
              dangerSeqs={missingTable.map((m) => m.wpSeq)}
            />
            <div style={{ marginTop: 8 }}>
              {missingTable.length > 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  待补航拍点：
                  {missingTable.map((m) => `#${m.wpSeq}`).join('、')}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  无漏拍航点
                </Typography.Text>
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
