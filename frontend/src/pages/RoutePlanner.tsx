import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { loadFlightLine, saveFlightLine } from '../utils/db';
import { newId } from '../utils/id';
import { reconcileSorties, type ReconciledSortie } from '../utils/sortieCalc';
import type { FlightLine } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';
import type { ImageAsset } from '../types/imageasset';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

const sortieColumns: NonNullable<TableProps<ReconciledSortie>['columns']> = [
  { title: '架次', dataIndex: 'sortieNo', width: 70, render: (v: number) => `第 ${v} 架次` },
  {
    title: '航点范围',
    width: 130,
    render: (_: unknown, row: ReconciledSortie) =>
      row.fromSeq > 0 ? `#${row.fromSeq} ~ #${row.toSeq}` : '—',
  },
  { title: '预计张数', dataIndex: 'estPhotos', width: 90 },
  { title: '实际张数', dataIndex: 'actualPhotos', width: 90 },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (v: string) => {
      const color = v === '已飞' ? 'green' : v === '漏拍' ? 'red' : 'default';
      return <Tag color={color}>{v}</Tag>;
    },
  },
  {
    title: '漏拍航点',
    dataIndex: 'missedSeqs',
    render: (seqs: number[]) => (seqs.length > 0 ? seqs.map((s) => `#${s}`).join('、') : '—'),
  },
];

/** /missions/:id/route 航线规划主视图：地图 + 参数面板实时回算 + 架次对账 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const assets = useAssetStore((s) => s.items);
  const sorties = useSortieStore((s) => s.items);
  const recalculateSorties = useSortieStore((s) => s.recalculate);
  const mission = missions.find((m) => m.id === id);
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );
  const missionAssets = useMemo(() => assets.filter((a) => a.missionId === id), [assets, id]);
  const missionSorties = useMemo(() => sorties.filter((s) => s.missionId === id), [sorties, id]);

  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const [hasSavedLine, setHasSavedLine] = useState(false);
  const metrics = useRouteMetrics(id, params);

  // 用 ref 持有最新航点/影像，避免重算闭包过期
  const waypointsRef = useRef(missionWaypoints);
  const assetsRef = useRef(missionAssets);
  useEffect(() => {
    waypointsRef.current = missionWaypoints;
    assetsRef.current = missionAssets;
  }, [missionWaypoints, missionAssets]);

  // 参数或航点变化时重算架次（防抖 500ms）
  const firstLoadRef = useRef(true);
  useEffect(() => {
    if (!id || !hasSavedLine) return;
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void recalculateSorties(id, params, metrics, waypointsRef.current, assetsRef.current);
    }, 500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, id, hasSavedLine, missionWaypoints]);

  useEffect(() => {
    if (!id) return;
    void loadFlightLine(id).then((line) => {
      if (!line) return;
      setParams((prev) => ({
        ...prev,
        altitude: missionWaypoints[0]?.altitude ?? prev.altitude,
        overlapForward: line.overlapForward,
        overlapSide: line.overlapSide,
        heading: line.heading,
      }));
      setSavedText(`上次保存：${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
      setHasSavedLine(true);
    });
  }, [id, missionWaypoints.length]);

  useEffect(() => {
    if (missionWaypoints.length > 0) {
      setParams((prev) => ({ ...prev, altitude: missionWaypoints[0].altitude }));
    }
  }, [missionWaypoints.length]);

  const onSave = async () => {
    if (!mission) return;
    const line: FlightLine = {
      id: newId('line'),
      missionId: mission.id,
      lineNo: 1,
      spacing: metrics.spacing,
      photoInterval: metrics.photoInterval,
      overlapForward: params.overlapForward,
      overlapSide: params.overlapSide,
      gsd: metrics.gsd,
      estPhotos: metrics.estPhotos,
      estDuration: metrics.estDuration,
      batteryCount: metrics.batteryCount,
      heading: params.heading,
      updatedAt: Date.now(),
    };
    await saveFlightLine(line);
    await recalculateSorties(mission.id, params, metrics, missionWaypoints, missionAssets);
    setHasSavedLine(true);
    setSavedText(`已保存 ${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
  };

  const pickPoint = async (lng: number, lat: number) => {
    if (!mission) return;
    if (missionWaypoints.length >= 60) {
      setError('单任务航点上限为 60 个，请拆分架次');
      return;
    }
    const seq = missionWaypoints.length === 0 ? 1 : Math.max(...missionWaypoints.map((w) => w.seq)) + 1;
    await addWaypoint({
      missionId: mission.id,
      seq,
      lng: Number(lng.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      altitude: params.altitude,
      speed: params.speed,
      heading: params.heading,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
    setError('');
  };

  const lineRows: LineRow[] = [
    { key: 'gsd', label: '地面分辨率 GSD', value: `${metrics.gsd} cm/px` },
    { key: 'spacing', label: '航线间距', value: `${metrics.spacing} m` },
    { key: 'interval', label: '拍照间隔', value: `${metrics.photoInterval} m` },
    { key: 'photos', label: '预计张数', value: `${metrics.estPhotos} 张` },
    { key: 'duration', label: '预计耗时', value: `${metrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${metrics.batteryCount} 组` },
    { key: 'area', label: '测区面积', value: `${metrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${metrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${metrics.lineCount} 条` },
  ];

  const reconciledSorties = useMemo(
    () => reconcileSorties(missionSorties, missionWaypoints, missionAssets),
    [missionSorties, missionWaypoints, missionAssets],
  );
  const pendingReview = useMemo(() => missionAssets.filter((a) => a.needsReview), [missionAssets]);
  const missedCount = reconciledSorties.filter((s) => s.status === '漏拍').length;

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航线规划 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>{mission.areaName}</Tag>
        <Tag color={missionWaypoints.length > 0 ? 'green' : 'default'}>航点 {missionWaypoints.length} 个</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button type="link">
          <Link to="/settings/camera">相机预设</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="测区与航线">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={params.altitude}
              height={440}
              onPickPoint={pickPoint}
            />
          </Card>
          <Card size="small" title="航线参数明细" style={{ marginTop: 14 }}>
            <Table<LineRow>
              rowKey="key"
              size="small"
              columns={lineColumns}
              dataSource={lineRows}
              pagination={false}
            />
          </Card>
          <Card
            size="small"
            title="架次对账"
            extra={
              <Space size={6}>
                {missedCount > 0 ? <Tag color="red">漏拍 {missedCount} 个架次</Tag> : null}
                {pendingReview.length > 0 ? <Tag color="gold">待复核 {pendingReview.length} 张</Tag> : null}
              </Space>
            }
            style={{ marginTop: 14 }}
          >
            {reconciledSorties.length === 0 ? (
              <Typography.Text type="secondary">
                保存航线参数后按续航自动分架次，记录航点范围与预计张数。
              </Typography.Text>
            ) : (
              <Table<ReconciledSortie>
                rowKey="id"
                size="small"
                columns={sortieColumns}
                dataSource={reconciledSorties}
                pagination={false}
              />
            )}
            {pendingReview.length > 0 ? (
              <Alert
                style={{ marginTop: 10 }}
                type="warning"
                showIcon
                message={`${pendingReview.length} 张影像待复核（架次划分已更新）`}
                description={
                  <Space wrap size={6}>
                    {pendingReview.map((a: ImageAsset) => (
                      <Tag key={a.id} color="gold">
                        {a.imageNo}
                        {a.reviewReason ? ` · ${a.reviewReason}` : ''}
                      </Tag>
                    ))}
                  </Space>
                }
              />
            ) : null}
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
          />
        </Col>
      </Row>

      <Card size="small" title="点击网格新增的航点">
        {missionWaypoints.length === 0 ? (
          <Typography.Text type="secondary">
            暂无航点：在地图/网格上单击即可按当前航高新增航点，或到「航点明细」页批量粘贴导入。
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {missionWaypoints.map((w: Waypoint) => (
              <Tag key={w.id} color={w.action === '悬停' ? 'gold' : 'blue'}>
                #{w.seq} {w.lng.toFixed(5)}, {w.lat.toFixed(5)} · {w.altitude} m · {w.action}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
