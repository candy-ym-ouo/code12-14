# 同株枝条跨年照片标注（annotator）

从零实现的照片标注服务，解决三个问题：

1. **跨年份同株枝条共用底图** —— 一张"底图"定义规范坐标系，2024/2025/2026…
   的照片（含取景偏移、放大、二次裁剪）各自携带 `baseToImage` 仿射矩阵；
   标注只有一份，坐标永远存在底图规范坐标系里，任何年份视图上自动原位显示。
2. **标注坐标随裁剪/缩放还原** —— 裁剪图矩阵 = 裁剪映射 ∘ 父图矩阵，可任意嵌套；
   画布的平移/滚轮缩放只是视图矩阵，与持久化无关；点/矩形/多边形统一走仿射变换。
3. **多人同时编辑同一标注按版本合并** —— 每个字段独立版本号（字段级版本向量），
   PATCH 带 `baseV` 做三方合并（base/ours/theirs）：改不同字段自动合并、改成相同值幂等、
   改同一字段才返回 409 并逐字段人工裁决（ours/theirs）；SSE 实时广播他人改动。

零第三方运行时依赖：纯 Node.js 20 `http` + 浏览器原生 Canvas；测试用内置 `node:test`。

## 运行

```bash
node src/server.mjs          # http://localhost:4178
# 可选：PORT=4178 ANNOTATOR_DATA=./data node src/server.mjs
npm test                     # 16 项：几何往返 / 版本合并 / 接口端到端 / SSE
```

首次启动自动生成演示植株「院角海棠 A-17」：

- `2024` 底图（1000×700，规范坐标）
- `2025` 取景偏中部、放大 1.25× 的照片（800×560）
- `2026` 在 2025 照片上二次裁剪放大的图（320×320）
- 三个标注：点（花芽①）、矩形（叶芽②）、多边形（顶芽③）

切换三个年份即可看到同一份标注落在枝条的同一个物理位置；在 ✂ 裁剪出的 2026
图上拖动标注，保存的仍是底图规范坐标。

## 使用

- 顶栏可切换/新建植株，"我是 ___"填入你的名字（随每个请求发送，用于合并与广播）。
- 左侧上传新年份照片（独立上传默认以自身像素为规范坐标）；右键照片列表可把它设为底图。
- 工具栏：✋选择/拖动标注、📍点、▭矩形、▽多边形（单击加点、双击闭合）、✂框选区域生成
  带级联矩阵的裁剪照片；滚轮以指针为锚点缩放。
- 选中标注后可改名称/颜色/年份范围/删除；开两个浏览器窗口用不同名字即可演示多人协作：
  两人改不同字段互不阻塞；同改一个字段弹出逐字段裁决框。

## 坐标模型

```text
屏幕点 ──view⁻¹──▶ 图像像素 ──baseToImage⁻¹──▶ 底图规范坐标（标注存储于此）
                         ▲
              每张照片各自携带 baseToImage
裁剪图:  baseToImage_crop = [缩放·平移] ∘ baseToImage_parent   （可嵌套）
```

矩阵采用列向量 2×3 仿射 `[a,b,c,d,e,f]`：`x'=a*x+c*y+e, y'=b*x+d*y+f`
（见 `lib/geometry.mjs`，前后端共用同一份同构模块）。

矩形在各向同性缩放/平移/90°倍数旋转下可逆；一般仿射（含斜切/任意旋转）下矩形变换
取四点轴对齐包围盒，点与多边形始终精确可逆。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/plants` | 植株列表/创建 |
| GET | `/api/plants/:id` | 植株 + 照片 + 标注 |
| GET | `/api/plants/:id/events` | SSE：`created`/`updated` 标注事件 |
| POST | `/api/plants/:id/photos` | 上传照片；带 `sourcePhotoId+cropRect` 时服务端级联裁剪矩阵 |
| POST | `/api/photos/:id/base` | 设为底图 |
| POST | `/api/plants/:id/annotations` | 创建标注（返回字段版本向量 `v`） |
| PATCH | `/api/annotations/:id` | `{set:{field:value}, baseV:{field:v}}` 三方合并 |
| POST | `/api/annotations/:id/resolve` | 409 后按 `{field:'ours'|'theirs'}` 裁决 |

PATCH 成功返回最新标注与合并字段；409 返回
`{error:'CONFLICT', fields:{field:{base,ours,theirs,oursV}}, current}`。

## 合并语义（`lib/merge.mjs`）

对补丁里的每个字段独立判定：

| 情况 | 结果 |
| --- | --- |
| base = ours（没人动过） | 接受 theirs，版本 +1 |
| ours = theirs | 幂等成功 |
| base = theirs（我没改） | 保留服务端值 |
| base≠ours 且 ours≠theirs 且 base≠theirs | 该字段 409，其余字段照常合并 |
| baseV > 服务端版本 | `BASE_AHEAD`，拒绝并返回当前状态 |

字段值历史保存在每字段的版本快照环（默认保留 50 个），用于取回任意 base 值。
存储为 `data/db.json`（原子写）+ `data/images/`，生产可将 `lib/store.mjs` 换成
Postgres 适配器，合并层与接口无需改动。

## 目录

```text
apps/annotator/
├─ src/server.mjs        # HTTP/静态/SSE/路由/合并接口
├─ lib/
│  ├─ geometry.mjs       # 仿射矩阵、裁剪级联、几何变换（前后端共用）
│  ├─ merge.mjs          # 字段级版本向量 + 三方合并 + 冲突裁决
│  ├─ store.mjs          # JSON 原子存储 + 字段历史快照 + 事件总线
│  └─ seed.mjs           # 演示数据（内置 PNG 编码器，无外部图片库）
├─ public/               # 原生 Canvas 前端（无框架、无构建）
└─ test/                 # geometry / merge 单测 + 真实 HTTP 端到端
```
