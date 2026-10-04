import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useSortieStore } from '../stores/sortieStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import { useSortieReconcile } from '../hooks/useSortieReconcile';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { loadFlightLine, saveFlightLine } from '../utils/db';
import { newId } from '../utils/id';
import { routeParamsSig } from '../types/sortie';
import type { FlightLine } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';

type LineRow = { key: string; label: string; value: string };

const lineColumns = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

/** /missions/:id/route 航线规划主视图：地图 + 参数面板实时回算 + 保存即分架次 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const assets = useAssetStore((s) => s.items);
  const sorties = useSortieStore((s) => s.items);
  const savePlan = useSortieStore((s) => s.savePlan);
  const mission = missions.find((m) => m.id === id);
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );
  const missionAssets = useMemo(() => assets.filter((a) => a.missionId === id), [assets, id]);
  const missionSorties = useMemo(
    () => sorties.filter((s) => s.missionId === id).sort((a, b) => a.sortieNo - b.sortieNo),
    [sorties, id],
  );

  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [savedText, setSavedText] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const metrics = useRouteMetrics(id, params);
  const reconcile = useSortieReconcile(id, params);

  // 打开页面载入已保存参数
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void loadFlightLine(id).then((line) => {
      if (!alive || !line) return;
      setParams((prev) => ({
        altitude: line.altitude ?? prev.altitude,
        speed: line.speed ?? prev.speed,
        overlapForward: line.overlapForward,
        overlapSide: line.overlapSide,
        heading: line.heading,
      }));
      setSavedText(`上次保存：${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  // 航点高度作为航高初值（仅在没有已保存航高时跟随）
  useEffect(() => {
    if (missionWaypoints.length > 0) {
      setParams((prev) => ({ ...prev, altitude: missionWaypoints[0].altitude }));
    }
    // 仅航点数变化时跟随一次，避免与用户手动改航高打架
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionWaypoints.length]);

  const onSave = async () => {
    if (!mission) return;
    if (missionWaypoints.length === 0) {
      setError('暂无航点：请先在网格上点击新增或到「航点明细」导入，再保存分架次');
      return;
    }
    const existing = await loadFlightLine(id);
    const now = Date.now();
    const line: FlightLine = {
      id: existing?.id ?? newId('line'),
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
      altitude: params.altitude,
      speed: params.speed,
      paramsSig: routeParamsSig(params),
      updatedAt: now,
    };
    await saveFlightLine(line);
    const res = await savePlan({
      missionId: mission.id,
      waypoints: missionWaypoints,
      assets: missionAssets,
      route: params,
    });
    setSavedText(`已保存 ${new Date(now).toLocaleString('zh-CN')}`);
    setError('');
    const parts = [
      `架次划分已重算：保留已编目 ${res.keptCount} 个、新划 ${res.newCount} 个`,
    ];
    if (res.reviewCount > 0) parts.push(`本次 ${res.reviewCount} 张影像受影响列入待复核`);
    setToast(parts.join('；'));
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

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
    { key: 'photos', label: '预计张数（拍照航点）', value: `${metrics.estPhotos} 张` },
    { key: 'duration', label: '预计耗时', value: `${metrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${metrics.batteryCount} 组` },
    { key: 'sortie', label: '续航分架次', value: `${metrics.sorties.length} 个架次（每架次 ≤ 20 min）` },
    { key: 'area', label: '测区面积', value: `${metrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${metrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${metrics.lineCount} 条` },
  ];

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
        <Tag color={missionSorties.length > 0 ? 'geekblue' : 'default'}>架次 {missionSorties.length} 个</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目 / 架次对账</Link>
        </Button>
        <Button type="link">
          <Link to="/settings/camera">相机预设</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {reconcile.stale ? (
        <Alert
          type="warning"
          showIcon
          message="航高 / 重叠率或航点已变化，当前架次划分失效"
          description={`已编目的 ${reconcile.flownCount} 个架次保持原样，点「保存航线参数并分架次」后未飞架次将按新参数重算，受影响影像列入待复核。`}
        />
      ) : null}
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
            <Table
              rowKey="key"
              size="small"
              columns={lineColumns}
              dataSource={lineRows}
              pagination={false}
            />
          </Card>
          <Card size="small" title="已保存架次（航点范围 · 预计/实到 · 对账）" style={{ marginTop: 14 }}>
            {missionSorties.length === 0 ? (
              <Typography.Text type="secondary">
                尚未保存航线参数，右侧调整后点「保存航线参数并分架次」即按续航生成架次。
              </Typography.Text>
            ) : (
              <Space wrap size={6}>
                {reconcile.rows.map((r) => {
                  const color =
                    r.status === 'ok' ? 'green' : r.status === 'short' ? 'red' : 'default';
                  const label =
                    r.status === 'ok' ? '齐' : r.status === 'short' ? `漏拍 ${r.missingCount}` : '未飞';
                  return (
                    <Tag key={r.sortie.id} color={color} style={{ marginBottom: 6 }}>
                      第 {r.sortie.sortieNo} 架次 · #{r.sortie.wpStartSeq}~#{r.sortie.wpEndSeq} · 预计 {r.estCount}/
                      实到 {r.actualCount} · {label}
                      {r.reviewCount > 0 ? ` · 待复核 ${r.reviewCount}` : ''}
                      {r.sortie.legacy ? ' · 旧数据补录' : ''}
                    </Tag>
                  );
                })}
                {reconcile.unassignedWaypoints.length > 0 ? (
                  <Tag color="orange">
                    {reconcile.unassignedWaypoints.length} 个航点不在任何架次区间，保存后重划
                  </Tag>
                ) : null}
              </Space>
            )}
          </Card>
          <Card size="small" title="当前参数下的架次预览" style={{ marginTop: 14 }}>
            <Space wrap size={6}>
              {metrics.sorties.length === 0 ? (
                <Typography.Text type="secondary">暂无航点</Typography.Text>
              ) : (
                metrics.sorties.map((s) => (
                  <Tag key={s.sortieNo} color="blue">
                    第 {s.sortieNo} 架次 · #{s.wpStartSeq}~#{s.wpEndSeq} · {s.estPhotos} 张 · {s.estDurationMin} min
                  </Tag>
                ))
              )}
            </Space>
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
            saveHint="保存即按续航分架次并记下航点范围与预计张数；已编目架次不动，未飞架次按新参数重算。"
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
