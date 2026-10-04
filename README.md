# sologsb-1123 无人机航拍航线与成果编目台（gbdronemap）

面向航拍作业与测绘内业人员：先按测区规划航线与航点（重叠率、相对航高、地面分辨率），再对飞行产出的成果影像逐张编目（片号、GSD、重叠度、质量）。范围只覆盖**航线规划**与**成果影像编目**本身。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21823**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 地图 | 高德地图 JS API 2.0（可选，key 缺失时自动退化） |
| 本地存储 | IndexedDB（Dexie 4），缩略图单独建表，含结构版本号与升级迁移 |

## VITE_AMAP_KEY 配置与退化行为（重要）

- key 从环境变量 `VITE_AMAP_KEY` 读取（`.env` / `.env.example` 中已留空）。
- **未配置 key（默认）**：`<AmapRouteView>` 自动渲染**本地 SVG 网格视图**——按经纬度等比投影，仍可绘制测区边界、航点折线、每个航点的视场矩形，并支持**点击网格新增航点**。此模式下页面**不发起任何外部网络请求**。
- **配置了 key**：动态加载 `https://webapi.amap.com/maps?v=2.0&key=...`，用高德地图绘制多边形 / 折线 / 航点 / 视场矩形。
- **构建与运行都不依赖该 key**：`vite.config.ts` 与 Dockerfile 均不校验 key；即使填了 key 但脚本加载失败或 8 s 超时，也会自动退化为 SVG 网格视图，页面顶部用 `Alert` 标明当前模式。

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite build
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1123/
├── docker-compose.yml
├── .env.example           # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── vite-env.d.ts
        ├── router/index.tsx
        ├── types/{mission,waypoint,flightline,imageasset,sortie}.ts
        ├── stores/{mission,waypoint,asset,sortie}Store.ts
        ├── components/common/{AmapRouteView,OverlapCalcPanel,AssetGrid,MissionCard}.tsx
        ├── hooks/{useMissionFilter,useRouteMetrics,useSortieReconcile}.ts
        ├── pages/{MissionList,RoutePlanner,WaypointTable,AssetCatalog,CameraPreset}.tsx
        └── utils/{db,geoCalc,sortieReconcile,amapLoader,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/missions` | 任务台账：按测区/机型/飞行日期区间/状态筛选，显示航线数、预计张数、成果条目数与架次对账（漏拍/待复核角标） | Mission |
| `/missions/:id/route` | 航线规划主视图：地图/网格绘制测区与航点折线，右侧参数面板改航高/航速/重叠率，实时回算 GSD、航线间距、预计张数与耗时；**保存即按续航分架次（航点范围+预计张数）**，航高/重叠率改动使未飞架次失效重算 | Mission、Waypoint、FlightLine、Sortie |
| `/missions/:id/waypoints` | 航点明细：经纬度粘贴导入、批量改高度、上下移与拖拽换序、单点视场预览 | Waypoint |
| `/missions/:id/assets` | 成果影像编目 + **架次对账**：影像按航点归入架次，张数不足/航点无影像标漏拍，漏拍航点一键补录，受影响影像进待复核队列，导出清单含架次对账行 | ImageAsset、Sortie |
| `/settings/camera` | 相机与传感器参数预设管理，选定预设后带入任务的焦距/像元/传感器 | CameraPreset、Mission |

`/` 重定向到 `/missions`，未匹配路由同样兜底到 `/missions`。

## 关键算法

- **地面分辨率**：`GSD(cm/px) = 像元尺寸(μm) × 航高(m) / (焦距(mm) × 10)`
- **地面幅宽**：`幅宽(m) = 传感器尺寸(mm) × 航高(m) / 焦距(mm)`
- **航线间距** = 旁向幅宽 × (1 − 旁向重叠率)；**拍照间隔** = 航向幅宽 × (1 − 航向重叠率)
- **预计张数** = Σ(每条航带长度 / 拍照间隔 + 1)；架次对账时以**区间内「拍照」航点数**为准（悬停/转弯不产片）；**预计耗时** = (总航程 / 航速 + 转弯与悬停附加) / 60；**电池组数** 按 20 min 有效续航向上取整
- **测区面积**：经纬度投影到米制后用鞋带公式；**航带路径长度**：逐段球面近似距离累加

## 架次对账（航线 ↔ 成果）

保存航线参数时按电池续航（20 min/组）把**航点序列贪心切成架次**，逐架次记下航点范围 `wpStartSeq~wpEndSeq`、预计张数（区间拍照航点数）与预计耗时：

- **影像归架次**：按航点编目时直接写 `waypointId/sortieId`；旧影像无关联时按坐标就近匹配（30 m 容差），再按航点序号归入对应架次区间。
- **漏拍判定**：架次内某拍照航点没有任何影像 → 漏拍并列出该航点（图上红圈、可一键补录）；航点都有片但实到 < 预计 → 按差额标漏拍；无影像的未飞架次标「未飞」。
- **参数失效重算**：每个架次存航线参数签名（航高/航速/航向与旁向重叠率/航带方向）与航点指纹。航高或重叠率一改，未飞架次签名对不上即提示失效；保存后**已编目（`flown`）架次原样保留**，未飞架次作废，其余航点按新参数重划，挂在作废架次/落进重划区的影像标 `needsReview` 进**待复核**并按航点重新归位。编目挂片后架次由 `unflown` 转 `flown` 锁定。
- **旧数据兼容**：v3 升级后，对没有任何架次的已有任务，启动及进入编目页时按其已有影像的航点补出 `legacy` 架次并回填影像归属（幂等）。
- 导出 CSV 每个架次附一行对账汇总（航点范围、预计/实到、齐/漏拍/未飞）。

## 数据存储说明

- 数据库名 `gbdronemap`，当前结构版本 **v3**（`localStorage['gbdronemap:db-version']` 记录）。
- 七张表：`missions`（任务）、`waypoints`（航点）、`lines`（航线参数，含航高/航速/参数签名）、`assets`（成果影像条目，含 `waypointId/sortieId/needsReview`）、`thumbs`（**缩略图单独建表**，dataUrl）、`presets`（相机预设）、`sorties`（架次：航点范围、预计张数、参数与航点签名、`flown/unflown` 状态）。
- v1 → v2 迁移：为老任务补 `areaPolygon`/传感器默认值，为航线补 `updatedAt`/`batteryCount`，并新增索引。
- v2 → v3 迁移：新增 `sorties` 表，`assets` 增加 `sortieId/waypointId/needsReview` 索引，`lines` 增加 `altitude/speed/paramsSig`；老任务无架次时由前端按影像航点补录（`legacy` 标记，幂等）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范任务、5 个航点、2 条航线参数、2 个架次（任务 A 单架次已飞且第 3 拍照航点漏拍、含 1 张待复核；任务 B 单架次未飞）、6 条成果影像条目（含缩略图）与 3 套相机预设。
