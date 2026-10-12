# 屏损故障鉴定智能体

> **版本**：v5.3 | **更新**：2026-08-18

---

## 一、系统概述

屏损智能体是一套面向 TCL 一线售后人员的智能鉴定系统。售后人员在现场遇到屏幕故障时，通过手机 H5 完成「症状采集 → 拍照取证 → 物理触感检测 → 安装信息录入」，系统**自动以 DINOv2 深度特征向量检索匹配历史案例** + 决策树判定故障责任归属，并输出相似案例供现场比对。

核心亮点：
- **DINOv2 深度特征**：384 维语义向量（facebook/dinov2-small ViT-S/14）→ 余弦相似度匹配，替代传统手工特征
- **搜索融合**：图像相似度(60%) + 标签匹配(40%) 加权融合，准确率远超纯标签匹配
- **LLM 智能鉴定**：支持多模态大模型分析屏损位置、形态、原理、环节，SSE 流式输出鉴定报告
- **鉴定分析模式**：支持 RAG 纯检索 / LLM 纯大模型 / Hybird 混合三种分析模式，通过管理后台配置切换
- **电视图片方向处理**：后台可切换 OpenCV + 多模态自动旋转，或由用户逐张手动调整角度
- **手动鉴定按钮**：H5 页面提供「鉴定分析」按钮，支持拍照后手动触发分析，失败时显示错误信息
- **纠正反馈审核入库**：一线人员纠正分析结果后进入待审核队列，管理员审核通过后才正式入库并参与 RAG 检索
- **人工审核工作台**：管理后台提供待审核/已通过/已驳回三态审核，确保案例库数据质量
- **判定正确率反馈**：H5 判定结果支持用户「正确/有误」反馈，仪表盘实时展示判定正确率
- **评估体系**：内置 LLM vs 人工标注对比评估，支持批量评测 + 混淆矩阵 + Excel 导出
- **快速标注**：管理后台批量导入图片 → AI 自动预填 + 一键标注 → 入库为案例
- **自动索引**：创建/导入案例时自动提取特征写入向量库，无需手动训练
- **管理后台**：案例库 CRUD + 批量图片入库 + 一键重建向量索引 + 规则发布
- **SQL 自助查询**：支持自定义 SQL 查询 + Excel 导出
- **全 JavaScript**：统一为纯 Node.js ESM + Python FastAPI

电视方向处理的完整流程、后台配置和调试方法见 [电视图片方向处理功能说明](docs/电视图片方向处理功能说明.md)。

---

## 二、系统架构

```
┌───────────────────────────────────────────────────────────┐
│              一线售后人员 (手机浏览器)                       │
│          http://localhost:8080/                            │
│  症状采集 → 拍照取证 → 鉴定分析 → 结果查看 → 纠正反馈       │
└──────────────────────┬────────────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────────┐
│  gateway-bff     :8080    Node.js (Fastify-like)        │
│  前端托管 + 请求聚合 + API 代理 + SSE 流式透传              │
└──┬───────────┬──────────────┬───────────────────────────┘
   │           │              │
   ▼           ▼              ▼
┌─────────┐ ┌────────────┐ ┌───────────────────────┐
│engine   │ │knowledge-ai│ │decision-admin          │
│:8081    │ │:8083       │ │:8082                   │
│Node.js  │ │Node.js     │ │Node.js                  │
│         │ │            │ │                        │
│决策树   │ │DINOv2 向量 │ │案例管理 + 批量导入       │
│判定引擎 │ │+ 标签融合   │ │评估体系管理              │
│置信度   │ │LLM 分析    │ │向量索引重建 + 规则管理   │
│打分机制 │ │知识库 RAG  │ │模型配置管理              │
└─────────┘ └─────┬──────┘ └───────────────────────┘
                  │
                  ▼
         ┌───────────────────┐
         │ Python 特征服务    │
         │ :8084              │
         │ DINOv2 ViT-S/14    │
         │ 384维 语义向量      │
         │ (内存索引/Milvus)  │
         └───────────────────┘
```

| 服务 | 端口 | 职责 |
|------|:---:|------|
| **gateway-bff** | 8080 | 前端 H5 托管 + API 聚合代理 + SSE 流式透传 |
| **decision-engine** | 8081 | 决策树判定引擎 + 置信度打分 |
| **decision-admin** | 8082 | 管理中台（案例库 + 向量索引 + 评估 + 规则 + 模型配置） |
| **knowledge-ai** | 8083 | 知识检索 + DINOv2 向量融合匹配 + LLM 分析 + RAG |
| **python-features** | 8084 | DINOv2 ViT-S/14 图像特征提取 (384维) + 电视方向检测/OCR + 向量数据库 |

---

## 三、功能清单

### 3.1 一线售后 — 手机端 H5

访问：**`http://localhost:8080/`**

| 步骤 | 功能 | 操作 |
|:---:|------|------|
| ① | 症状初筛：屏损类型可视化卡片，多选 | 点击卡片 |
| ② | 拍照取证：调用摄像头（后置优先），支持多张 | 点击「📷 拍照」 |
| ② | 微距引导：虚线框 + 强制对焦提示 | 点击「微距辅助线」 |
| ② | 鉴定分析：手动触发按钮，遵循管理后台配置的分析模式 | 点击「鉴定分析」 |
| ③ | 物理触感：凹凸感/内屏裂痕 | 开关选择 |
| ④ | 安装信息：安装状态/开箱人员/包装/故障环节 | 下拉 + 多选 |
| ⑤ | LLM 流式分析：多模态大模型实时输出鉴定报告 | 自动或手动触发 |
| ⑤ | 相似案例：向量+标签融合匹配，Top 5 推荐 | 自动加载 |
| ⑤ | 判定反馈：对判定结果反馈「正确/有误」 | 手动操作 |
| ⑤ | 纠正反馈：纠正鉴定结论并填写备注，进入待审核队列 | 手动操作 |

### 3.2 管理后台

访问：**`http://localhost:8082/admin`**

#### 案例库管理
- 案例 CRUD（创建 / 编辑 / 删除 / 批量删除）
- JSON 批量导入 / 导出
- 自定义标注字段（Tag 标签、结论按钮、文本域、输入框）
- 图片批量入库 + 快速标注
- 案例新增「问题备注」字段

#### 人工审核工作台（核心功能）
- H5 纠正提交的案例进入待审核队列，不直接入库
- 待审核 / 已通过 / 已驳回 三态管理
- 审核人姓名 + 驳回原因记录
- 通过后自动创建案例并进入 RAG 检索索引
- 确保案例库数据质量，避免低质量纠正污染检索

#### 快速标注（核心功能）
- 拖拽批量导入图片
- **AI 批量预填**：对未标注图片逐张调 LLM，带实时进度条
- **AI 分析此图**：单张调用 LLM 填入全部字段
- 标注字段自由配置：屏损位置、形态、环节、原理、鉴定结论等
- 快捷键操作：← → 切换 / Enter 下一张 / Esc 退出
- 支持漏液、熔屏等特殊屏损形态标注
- 标签按钮点击切换：选中再次点击取消

#### 模型配置
- **标注分析模式**：RAG / LLM / Hybird 三种模式可切换
- **图片方向模式**：自动旋转 / 用户手动调整，手动模式跳过方向检测以缩短等待时间
- **主模型**：LLM 接口配置（API Key / Endpoint / 温度 / Max Token）
- **系统提示词**：自定义鉴定指令，支持任意格式输出
- **标注模型**：独立配置标注专用模型（支持便宜模型降本）
- **标注提示词**：自定义标注的系统级提示词
- **RAG 知识库**：文档上传 / 检索配置 / 开关控制
- 模型测试：上传图片实时验证配置

#### 评估体系
- LLM 标注 vs 人工标注对比评估
- 批量评测 + 混淆矩阵分析
- 分字段准确率统计（位置/形态/环节/结论/状态观测/原理）
- Excel 评估报告导出

#### 向量检索
- 一键重建向量索引
- 向量服务状态监控
- DINOv2 可用性检测

### 3.3 向量检索

| 特性 | 说明 |
|------|------|
| **特征维度** | 384 维：DINOv2 ViT-S/14 CLS Token |
| **模型** | facebook/dinov2-small |
| **相似度算法** | L2归一化 → 余弦相似度（点积） |
| **融合得分** | 图像相似度 × 0.6 + 标签匹配 × 0.4 |
| **匹配阈值** | ≥80% 覆盖分析结论 / ≥70% 高亮推荐 / <50% 过滤 |
| **存储引擎** | 内存索引（numpy 余弦相似度），可选 Milvus |
| **自动索引** | 创建案例时自动提取特征写入向量库 |

---

## 四、启动与运行

### 4.1 环境要求

- **Node.js** v20+
- **Python** 3.10+（建议使用 venv）
- Node.js 依赖：`npm ci && npm ci --omit=dev --prefix services/knowledge-ai`
- Python 依赖：`python -m pip install -r services/knowledge-ai/python/requirements.txt`
- DINOv2 模型需提前下载至本地缓存（首次运行自动下载 `facebook/dinov2-small`）
- 必须分别配置 `ADMIN_API_TOKEN` 和 `INTERNAL_SERVICE_TOKEN`；两者应使用不同的高强度随机值，禁止提交到仓库

### 4.2 一键启动（PM2 推荐）

```bash
# 安装 PM2
npm install -g pm2

# 示例：使用密码管理系统注入两个不同的随机令牌
export ADMIN_API_TOKEN="$(openssl rand -hex 32)"
export INTERNAL_SERVICE_TOKEN="$(openssl rand -hex 32)"

# 启动所有服务
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status

# 查看日志
pm2 logs
```

Docker Compose 部署时先复制 `.env.example` 为 `.env`，填入两个独立令牌，再执行：

```bash
docker compose config --quiet
docker compose up -d --build
```

Compose 默认只把 `8080` 和管理端 `8082` 绑定到本机回环地址，避免绕过 TLS 反向代理；不要在公网直接发布 `8081`、`8082`、`8083`、`8084`。

默认 Compose 内网为 `172.30.240.0/24`，BFF 只信任其网关 `172.30.240.1` 注入的 `X-Forwarded-For`，从而在宿主 Nginx 后仍按真实客户端限流。若网段冲突，必须成对修改 `.env` 中的 `SCREEN_DAMAGE_SUBNET` 与 `SCREEN_DAMAGE_GATEWAY`，不要把不可信地址加入代理白名单。

LLM 默认全局预算为每分钟 30 次、每天 500 次、并发 3；向量分析并发为 4。可通过 `.env` 中的 `LLM_GLOBAL_REQUESTS_PER_MINUTE`、`LLM_GLOBAL_REQUESTS_PER_DAY`、`LLM_GLOBAL_CONCURRENCY`、`VECTOR_GLOBAL_CONCURRENCY` 调整。限额按进程实例计数，多副本部署时需接入共享限流存储或按副本数折算。

### 4.3 分步启动（调试用）

```bash
# 终端 1 — Python 特征服务 :8084（必须先启动）
python services/knowledge-ai/python/main.py

# 终端 2 — Node.js 知识库服务 :8083
node services/knowledge-ai/src/index.mjs

# 终端 3 — Node.js 管理中台 :8082
node services/decision-admin/src/index.mjs

# 终端 4 — Node.js 决策引擎 :8081
node services/decision-engine/src/index.mjs

# 终端 5 — Node.js BFF 网关 :8080
node services/gateway-bff/src/index.mjs
```

### 4.4 可选：Milvus 向量数据库

```bash
docker run -d --name milvus-standalone -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest
```

Python 服务启动时自动检测 Milvus，检测到则优先使用，未检测到则回退内存索引。

### 4.5 Nginx 反向代理（生产部署）

根目录 `nginx-site.conf` 是强制 TLS 的生产模板：80 端口只做 HTTPS 跳转，443 端口才代理应用。部署前必须：

1. 将 `screen-damage.example.com` 替换为证书对应的真实域名。
2. 将证书链和私钥以只读方式放到 `/etc/nginx/tls/fullchain.pem` 与 `/etc/nginx/tls/privkey.pem`。
3. 执行 `nginx -t` 后再 reload。证书缺失时配置应拒绝启动，禁止为了绕过检查而退回明文 HTTP。

模板还按应用实际限制收紧了请求体：普通判定 32KB、反馈 16KB、单图 9MB、纠错 4MB、多图 LLM 22MB。图片与 LLM 请求关闭 Nginx 请求体预缓冲，由 Nginx 流式转发，同时仍由 Nginx 和应用双重校验总大小并限制慢速上传。

如果 TLS 在负载均衡器终止，负载均衡器到本机 Nginx 的链路也必须位于可信隔离网络，并应由防火墙阻止用户直接访问后端端口。

### 4.6 访问地址

| 地址 | 用途 | 角色 |
|------|------|------|
| `https://你的域名/` | H5 鉴定页面 | 一线售后 |
| `https://你的域名/admin` | 管理后台 | 导师/管理员 |
| `http://localhost:8083/api/knowledge/vector-stats` | 向量服务状态 | 调试 |

---

## 五、API 接口

### 5.1 BFF 网关原生端点 (:8080)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 网关健康检查 |
| POST | `/api/v1/cases/decide` | 案例判定（调决策引擎 + 知识检索） |
| POST | `/api/v1/cases/search-similar` | 相似案例搜索 |
| GET | `/` | H5 前端页面 |
| GET | `/index.html` | H5 前端页面 |

### 5.2 Knowledge-AI 代理端点 (:8080 → :8083)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/knowledge/model-config` | 主模型配置 |
| GET/POST | `/api/knowledge/annotation-config` | 标注模型配置 |
| POST | `/api/knowledge/search-vector` | 纯向量检索 |
| POST/PATCH | `/api/knowledge/assessment-records` | 创建鉴定记录并保存处理后图片 / 更新鉴定结果 |
| POST | `/api/knowledge/correction` | 提交纠错（进入待审核队列） |
| POST | `/api/knowledge/annotate-single` | 单张图片 AI 标注 |
| POST | `/api/knowledge/annotate-batch` | 批量图片 AI 标注 |
| GET | `/api/knowledge/cases/result-stats` | 案例结果统计 |
| POST | `/api/knowledge/analyze-llm-stream` | LLM 流式分析 (SSE) |
| GET | `/api/knowledge/field-defs` | 集中式字段定义 |
| GET | `/api/knowledge/images` | 案例图片代理（二进制透传） |
| POST | `/api/knowledge/sql-query` | SQL 自助查询 |
| POST | `/api/knowledge/sql-query/export` | SQL 结果 Excel 导出 |

### 5.3 Knowledge-AI 内部端点 (:8083)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/knowledge/health` | 服务健康检查 |
| GET | `/api/knowledge/stats` | 知识库统计 |
| GET | `/api/knowledge/backup` | 数据备份 |
| GET | `/api/knowledge/case` | 案例详情 |
| POST | `/api/knowledge/search` | 融合检索（图像+标签） |
| POST | `/api/knowledge/search-vector` | 纯向量检索 |
| GET | `/api/knowledge/vector-stats` | 向量服务状态 |
| POST | `/api/knowledge/rebuild-index` | 重建向量索引 |
| POST | `/api/knowledge/extract` | 图像特征提取 |
| GET/POST/PUT/DELETE | `/api/knowledge/cases` | 案例 CRUD |
| POST | `/api/knowledge/cases/batch-delete` | 批量删除案例 |
| POST | `/api/knowledge/cases/batch` | 批量导入案例 |
| GET | `/api/knowledge/images` | 案例图片 |
| POST | `/api/knowledge/cases/from-images` | 图片批量入库 |
| GET/POST | `/api/knowledge/training` | 训练数据管理 |
| POST | `/api/knowledge/correction` | 纠错反馈（写入待审核队列） |
| POST/PATCH | `/api/knowledge/assessment-records` | 创建鉴定记录 / 更新处理状态和结果 |
| GET | `/api/knowledge/assessment-records` | 管理员分页查询鉴定记录 |
| GET/DELETE | `/api/knowledge/assessment-record` | 管理员查看 / 删除鉴定记录 |
| GET | `/api/knowledge/assessment-image` | 管理员读取鉴定记录图片 |
| POST | `/api/knowledge/feedback` | 提交判定正确率反馈 |
| GET | `/api/knowledge/feedback/stats` | 判定正确率统计 |
| POST | `/api/knowledge/feedback/report` | 判定报错（翻转正确→不正确） |
| GET | `/api/knowledge/review/pending` | 待审核案例列表 |
| GET | `/api/knowledge/review/stats` | 审核统计 |
| POST | `/api/knowledge/review/approve` | 审核通过（入库 + 索引） |
| POST | `/api/knowledge/review/reject` | 审核驳回 |
| POST | `/api/knowledge/analyze-llm` | LLM 分析（非流式） |
| POST | `/api/knowledge/analyze-llm-stream` | LLM 流式分析 (SSE) |
| POST | `/api/knowledge/annotate-single` | 单张 AI 标注 |
| POST | `/api/knowledge/annotate-batch` | 批量 AI 标注 |
| GET/POST | `/api/knowledge/model-config` | 模型配置 |
| GET/POST | `/api/knowledge/annotation-config` | 标注配置 |
| GET | `/api/knowledge/field-defs` | 字段定义 |
| GET | `/api/knowledge/eval/list` | 评估列表 |
| POST | `/api/knowledge/eval/create` | 创建评估 |
| POST | `/api/knowledge/eval/upload-images` | 评估图片上传 |
| POST | `/api/knowledge/eval/save` | 保存评估标注 |
| POST | `/api/knowledge/eval/batch-analyze` | 批量评估分析 |
| GET | `/api/knowledge/eval/stats` | 评估统计 |
| GET | `/api/knowledge/eval/export-xlsx` | 评估 Excel 导出 |
| POST | `/api/knowledge/eval/batch` | 批量评估操作 |
| POST | `/api/knowledge/eval/sync-to-cases` | 评估同步到案例 |
| POST | `/api/knowledge/eval/batch-delete` | 批量删除评估 |
| POST | `/api/knowledge/eval/clean-orphans` | 清理孤立评估 |
| GET | `/api/knowledge/kb/stats` | 知识库统计 |
| GET | `/api/knowledge/kb/documents` | 知识库文档列表 |
| GET | `/api/knowledge/kb/document` | 知识库文档详情 |
| POST | `/api/knowledge/kb/upload` | 文档上传 |
| DELETE | `/api/knowledge/kb/document` | 文档删除 |
| POST | `/api/knowledge/kb/search` | 知识库检索 |
| GET | `/api/knowledge/dashboard` | 仪表盘统计 |
| GET | `/api/knowledge/sql-schema` | SQL 数据库结构 |
| POST | `/api/knowledge/sql-query` | SQL 自助查询 |
| POST | `/api/knowledge/sql-query/export` | SQL 结果导出 |

### 5.4 案例判定请求体

```
POST /api/v1/cases/decide
Content-Type: application/json

{
  "symptoms": ["dot_star", "patch_leak"],
  "installStatus": "not_installed",
  "authPersonnel": "yes",
  "packageDamage": "none",
  "faultLinks": ["product_factor"],
  "touchFeel": { "hasBumpFeeling": false, "crackUnderGlassOnly": false }
}
```

### 5.5 LLM 流式分析 (SSE)

```
POST /api/knowledge/analyze-llm-stream
Content-Type: application/json

{
  "images": ["data:image/jpeg;base64,..."],
  "context": "安装状态：未安装，包装：无损坏"
}
```

响应为 SSE 流式，实时输出鉴定报告。

---

## 六、决策规则集

当前预置 7 个决策节点 + 5 个结论节点：

```
屏损故障发生
  ├─ 是否已安装？
  │   ├─ 是 → 非产品质量问题
  │   └─ 否 → 开箱人员是否为TCL授权？
  │           ├─ 否 → 非产品质量问题
  │           └─ 是 → 包装箱是否有破损？
  │                   ├─ 有破损 → 故障含物流？→ 物流问题
  │                   └─ 无破损 → 故障含产品因素？→ 产品质量问题
  │                               └─ 否 → 需进一步综合判定
```

### 置信度打分

| 因素 | 加分 |
|------|:--:|
| 基础分 | 70 |
| 冲击点 + 蝴蝶斑同时存在 | +15 |
| 仅有冲击点或蝴蝶斑 | +7 |
| 有屏损位置信息 | +8 |
| 决策路径 ≥ 3 步 | +5 |
| 症状 ≥ 3 种 | +5 |
| 症状 ≥ 1 种 | +2 |
| 满分 | 100 |
| < 70 → 标记需专家复核 | |

---

## 七、数据库结构

### SQLite 数据库 (knowledge.db)

#### cases 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT (PK) | 案例 ID |
| title | TEXT | 标题 |
| deviceModel | TEXT | 设备型号 |
| symptoms | JSON | 症状列表 |
| crackShape | JSON | 屏损形态 |
| crackLocation | TEXT | 屏损位置 |
| physicalFeature | TEXT | 物理特征 |
| liquidState | TEXT | 漏液状态 |
| installStatus | TEXT | 安装状态 |
| packageDamage | TEXT | 包装损坏 |
| crackStage | TEXT | 屏损环节 |
| crackPrinciple | TEXT | 屏损原理 |
| result | TEXT | 鉴定结果 |
| resultLabel | TEXT | 结果标签 |
| summary | TEXT | 摘要 |
| tags | JSON | 标签 |
| images | JSON | 图片列表 |
| possibleCause | TEXT | 可能原因 |
| warrantyTip | TEXT | 保修提示 |
| corrections | JSON | 纠正记录 |
| needsReview | INTEGER | 是否需要复核 |
| remark | TEXT | 问题备注 |
| review_status | TEXT | 审核状态（approved/pending/rejected） |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

#### pending_cases 表（待审核案例队列）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增 ID |
| title | TEXT | 标题 |
| deviceModel | TEXT | 设备型号 |
| statusObs | TEXT | 状态观测 |
| crackLocation | TEXT | 屏损位置 |
| crackShape | TEXT | 屏损形态 |
| crackPrinciple | TEXT | 屏损原理 |
| crackStage | TEXT | 屏损环节 |
| result | TEXT | 鉴定结论 |
| remark | TEXT | 问题备注 |
| imageBase64 | TEXT | 图片 Base64 |
| source | TEXT | 数据来源 |
| status | TEXT | 审核状态（pending/approved/rejected） |
| reviewed_by | TEXT | 审核人 |
| review_remark | TEXT | 审核备注 |
| created_at | TEXT | 创建时间 |
| reviewed_at | TEXT | 审核时间 |

#### feedback 表（鉴定主记录与结果反馈）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增 ID |
| submission_id | TEXT (UNIQUE) | 用户端单次鉴定 ID |
| process_status | TEXT | 处理状态（analyzing/completed/failed） |
| install_status | TEXT | 安装状态 |
| auth_personnel | TEXT | 是否由授权人员开箱 |
| package_damage | TEXT | 包装破损状态 |
| fault_links | JSON | 故障环节列表 |
| analysis_mode | TEXT | 分析模式（hybrid/rag 等） |
| analysis_payload | JSON | AI 分析完整结果 |
| decision_payload | JSON | 决策引擎完整结果 |
| llm_conclusion | TEXT | LLM 结论 |
| final_result | TEXT | 最终判定结果 |
| image_count | INTEGER | 关联图片数量 |
| error_message | TEXT | 失败原因 |
| case_id | TEXT | 关联案例 ID |
| conclusion | TEXT | 鉴定结论 |
| status | TEXT | 用户反馈状态（unconfirmed/confirmed_correct/reported_incorrect） |
| remark | TEXT | 备注 |
| source | TEXT | 来源（h5 等） |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |
| completed_at | TEXT | 鉴定完成时间 |

#### feedback_images 表（鉴定图片元数据）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增 ID |
| feedback_id | INTEGER (FK) | 关联 `feedback.id`，主记录删除时级联删除 |
| sort_order | INTEGER | 用户上传顺序 |
| filename | TEXT | 相对 `data/feedback-images/` 的本地文件路径 |
| mime_type | TEXT | 服务端检测到的图片类型 |
| file_size | INTEGER | 文件字节数 |
| width / height | INTEGER | 图片尺寸 |
| sha256 | TEXT | 文件内容摘要 |
| created_at | TEXT | 创建时间 |

#### training 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增 ID |
| features | JSON | 特征向量 |
| statusObs | TEXT | 状态观测 |
| location | TEXT | 屏损位置 |
| shape | TEXT | 屏损形态 |
| principle | TEXT | 屏损原理 |
| stage | TEXT | 屏损环节 |
| conclusion | TEXT | 鉴定结论 |
| caseId | TEXT | 关联案例 ID |
| source | TEXT | 数据来源 |
| imageBase64 | TEXT | 图片 Base64 |
| remark | TEXT | 问题备注 |
| created_at | TEXT | 创建时间 |

#### evaluations 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER (PK) | 自增 ID |
| case_id | TEXT (UNIQUE) | 案例 ID |
| case_title | TEXT | 案例标题 |
| image_name | TEXT | 图片名 |
| llm_* | TEXT | LLM 标注字段 |
| human_* | TEXT | 人工标注字段 |
| match_* | INTEGER | 匹配结果（-1=未判断, 0=不匹配, 1=匹配） |
| rag_* | TEXT | RAG 推断字段 |
| analyzed | INTEGER | 是否已分析 |
| judged_by | TEXT | 判定人 |

---

## 八、快速标注字段配置

管理后台支持动态配置标注字段，默认包含：

| ID | 标签 | 类型 | 必填 | 选项示例 |
|------|------|:---:|:---:|------|
| `title` | 标题 | input | | |
| `crackLocation` | 屏损位置 | tag-grid | ✓ | 天侧/地侧/左侧/右侧/四角区域/中央区域/全屏区域/局部不规则区域 |
| `crackShape` | 屏损形态 | tag-grid | ✓ | 单条线状屏裂/多条线状屏裂/点放射状屏裂/发散性线状屏裂/环状圈状屏裂/网状屏裂/漏液/熔屏 |
| `crackStage` | 屏损环节 | tag-grid | | 产品因素/物流运输搬运/拆机验机安装/使用保管不当 |
| `result` | 鉴定结论 | result-btns | | 质量问题/非质量问题/屏幕完好 |
| `installStatus` | 安装状态 | tag-grid | | 已安装/未安装 |
| `packageDamage` | 包装状态 | tag-grid | | 无损坏/轻微损坏/严重损坏 |
| `crackPrinciple` | 屏损原理 | textarea | | 自由文本（分析为何损坏的成因推断） |
| `remark` | 问题备注 | textarea | | 自由文本（问题补充说明） |

字段可在「管理后台 → 模型配置 → ⚙ 标注字段配置」中自由增删改。

---

## 九、项目文件结构

```
屏损智能体/
├── frontend/
│   └── index.html                     ← H5 单文件 SPA（~3000 行）
├── services/
│   ├── shared/
│   │   └── server-utils.mjs           ← 公共 HTTP 工具模块
│   ├── gateway-bff/                   ← :8080 请求聚合 + 前端托管
│   │   ├── Dockerfile
│   │   └── src/
│   │       └── index.mjs              ← BFF 路由 + API 代理 + SSE 透传
│   ├── decision-engine/               ← :8081 决策树判定引擎
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.mjs              ← 决策 API + 规则加载
│   │       └── decision-tree.mjs      ← 决策树评估逻辑
│   ├── decision-admin/                ← :8082 管理中台
│   │   ├── Dockerfile
│   │   ├── src/
│   │   │   ├── index.mjs              ← 规则 CRUD + 发布 + 知识代理
│   │   │   ├── rules-store.mjs        ← 基于 JSON 文件的规则存储
│   │   │   └── server-utils.mjs
│   │   └── static/
│   │       └── admin.html             ← 管理后台 SPA（~3000 行）
│   └── knowledge-ai/                  ← :8083 知识检索 + 向量融合 + LLM
│       ├── Dockerfile
│       ├── Dockerfile.python
│       ├── src/
│       │   ├── index.mjs              ← API 路由（~50 个端点）
│       │   ├── assessment-records.mjs ← 鉴定记录与本地图片存储
│       │   ├── search-engine.mjs      ← 向量融合检索 + 案例 CRUD + 纠正反馈
│       │   ├── llm-analyzer.mjs       ← LLM 分析 + 标注模型 + SSE 流式
│       │   ├── knowledge-base.mjs     ← RAG 知识库管理
│       │   ├── clip-client.mjs        ← Python 特征服务 HTTP 客户端
│       │   ├── db.mjs                 ← SQLite 数据库 + 迁移 + 备份
│       │   ├── field-normalize.mjs    ← 字段值规范化（中英文映射）
│       │   └── server-utils.mjs
│       ├── data/
│       │   ├── knowledge.db           ← SQLite 数据库
│       │   ├── model-config.json      ← 主模型配置（含 Key，不入库）
│       │   ├── annotation-config.json ← 标注模型配置（含 Key，不入库）
│       │   ├── field-defs.json        ← 集中式字段定义
│       │   ├── knowledge-base.json    ← 知识库文档索引
│       │   ├── backup/                ← 数据库自动备份（保留 7 天）
│       │   ├── feedback-images/        ← 用户鉴定处理后图片（不入库）
│       │   └── images/                 ← 案例图片存储
│       └── python/
│           ├── main.py                ← DINOv2 特征服务 (FastAPI)
│           └── requirements.txt       ← Python 依赖
├── docker-compose.yml                 ← 5 服务编排
├── ecosystem.config.cjs               ← PM2 生产部署配置
├── nginx-site.conf                    ← Nginx 反向代理配置
├── start.ps1                          ← Windows 开发启动脚本
├── .gitignore
└── README.md
```

---

## 十、如何提升准确率

1. **积累高质量案例**：在管理后台录入清晰的特征图片 + 准确的标签（crackLocation/crackShape），创建即自动索引
2. **标签准确**：融合分依赖标签匹配（权重 40%），标签越准融合分越可靠
3. **类型覆盖**：每种屏损（漏液/裂纹/冲击点/偏光片划伤）至少 3 个案例
4. **重建索引**：特征算法更新后，在管理后台点击「重建向量库」
5. **标注提示词优化**：在标注模型配置中微调 systemPrompt，让 LLM 输出更精准的成因分析
6. **利用评估体系**：通过 LLM vs 人工对比评估，持续监控模型标注准确率
7. **纠正反馈闭环**：一线人员的纠正结果会自动同步到案例库，形成数据闭环

准确率取决于案例库质量而非模型训练——**创建案例 = 训练**。
