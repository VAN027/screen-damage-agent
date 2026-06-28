# 屏损故障鉴定智能体

> **版本**：v5.1 | **更新**：2026-06-28

---

## 一、系统概述

屏损智能体是一套面向 TCL 一线售后人员的智能鉴定系统。售后人员在现场遇到屏幕故障时，通过手机 H5 完成「症状采集 → 拍照取证 → 物理触感检测 → 安装信息录入」，系统**自动以图像向量检索匹配历史案例** + 决策树判定故障责任归属，并输出相似案例供现场比对。

核心亮点：
- **向量检索**：512维图像特征（色阶直方图 + 分块均值 + Sobel边缘 + LBP纹理）→ 余弦相似度匹配
- **搜索融合**：图像相似度(60%) + 标签匹配(40%) 加权融合，准确率远超纯标签匹配
- **LLM 智能鉴定**：支持多模态大模型分析屏损位置、形态、原理、环节，流式输出鉴定报告
- **快速标注**：管理后台批量导入图片 → AI 自动预填 + 一键标注 → 入库为案例
- **自动索引**：创建/导入案例时自动提取特征写入向量库，无需手动训练
- **管理后台**：案例库 CRUD + 批量图片入库 + 一键重建向量索引 + 规则发布
- **全 JavaScript**：已移除所有 TypeScript，统一为纯 Node.js + Python

---

## 二、系统架构

```
┌───────────────────────────────────────────────────────────┐
│              一线售后人员 (手机浏览器)                       │
│          http://localhost:8080/                            │
│  症状采集 → 拍照取证 → 触感检测 → 安装信息 → 判定结果        │
└──────────────────────┬────────────────────────────────────┘
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────────┐
│  gateway-bff     :8080    Node.js                        │
│  前端托管 + 请求聚合 + API 代理 + SSE 流式透传              │
└──┬───────────┬──────────────┬───────────────────────────┘
   │           │              │
   ▼           ▼              ▼
┌─────────┐ ┌────────────┐ ┌───────────────────────┐
│engine   │ │knowledge-ai│ │decision-admin          │
│:8081    │ │:8083       │ │:8082                   │
│Node.js  │ │Node.js     │ │Node.js                  │
│         │ │            │ │                        │
│决策树   │ │向量+标签    │ │案例管理 + 批量导入       │
│判定引擎 │ │融合检索     │ │标注字段配置              │
│置信度   │ │LLM 分析    │ │向量索引重建 + 规则管理   │
│打分机制 │ │知识库 RAG   │ │模型配置管理              │
└─────────┘ └─────┬──────┘ └───────────────────────┘
                  │
                  ▼
         ┌───────────────────┐
         │ Python 特征服务    │
         │ :8084              │
         │ PIL+Numpy 512维    │
         │ 图像特征提取        │
         │ (内存索引/Milvus)  │
         └───────────────────┘
```

| 服务 | 端口 | 职责 |
|------|:---:|------|
| **gateway-bff** | 8080 | 前端托管 + 请求聚合 + API 代理 + SSE 流式透传 |
| **decision-engine** | 8081 | 决策树判定引擎 + 置信度打分 |
| **decision-admin** | 8082 | 管理中台（案例库 + 向量索引 + 规则 + 模型配置） |
| **knowledge-ai** | 8083 | 知识检索 + 向量融合匹配 + LLM 分析 + RAG |
| **python-features** | 8084 | 图像特征提取 (PIL+Numpy, 512维) |

---

## 三、功能清单

### 3.1 一线售后 — 手机端 H5

访问：**`http://localhost:8080/`**

| 步骤 | 功能 | 操作 |
|:---:|------|------|
| ① | 症状初筛：屏损类型可视化卡片，多选 | 点击卡片 |
| ② | 拍照取证：调用摄像头（后置优先），自动水印 | 点击「📷 拍照」 |
| ② | 微距引导：虚线框 + 强制对焦提示 | 点击「微距辅助线」 |
| ③ | 物理触感：凹凸感/内屏裂痕 | 开关选择 |
| ④ | 安装信息：安装状态/开箱人员/包装/故障环节 | 下拉 + 多选 |
| ⑤ | LLM 流式分析：多模态大模型实时输出鉴定报告 | 自动执行 |
| ⑤ | 相似案例：向量+标签融合匹配，Top 5 推荐 | 自动加载 |
| ⑤ | 纠正反馈：对分析结果纠错，提交为训练数据 | 手动操作 |

### 3.2 管理后台

访问：**`http://localhost:8082/admin`**

#### 案例库管理
- 案例 CRUD（创建 / 编辑 / 删除 / 批量删除）
- JSON 批量导入 / 导出
- 自定义标注字段（Tag 标签、结论按钮、文本域、输入框）
- 图片批量入库 + 快速标注

#### 快速标注（⚡ 核心功能）
- 拖拽批量导入图片
- **AI 批量预填**：对未标注图片逐张调 LLM，带实时进度条
- **AI 分析此图**：单张调用 LLM 填入全部字段
- 标注字段自由配置：屏损位置、形态、环节、原理、鉴定结论等
- 快捷键操作：← → 切换 / Enter 下一张 / Esc 退出
- 支持漏液、熔屏等特殊屏损形态标注
- 标签按钮点击切换：选中再次点击取消

#### 模型配置
- **主模型**：LLM 接口配置（API Key / Endpoint / 温度 / Max Token）
- **系统提示词**：自定义鉴定指令，支持任意格式输出
- **标注模型**：独立配置标注专用模型（支持便宜模型降本）
- **标注提示词**：自定义标注的系统级提示词
- **RAG 知识库**：文档上传 / 检索配置 / 开关控制
- 模型测试：上传图片实时验证配置

#### 向量检索
- 一键重建向量索引
- 向量服务状态监控
- CLIP 可用性检测

### 3.3 向量检索

| 特性 | 说明 |
|------|------|
| **特征维度** | 512 维：色阶(128) + 分块均值(128) + Sobel边缘(128) + LBP纹理(128) |
| **相似度算法** | L2归一化 → 余弦相似度（点积） |
| **融合得分** | 图像相似度 × 0.6 + 标签匹配 × 0.4 |
| **匹配阈值** | ≥80% 覆盖分析结论 / ≥70% 高亮推荐 / <50% 过滤 |
| **存储引擎** | 内存索引 + JSON持久化，可选 Milvus |
| **自动索引** | 创建案例时自动提取特征写入向量库 |

---

## 四、启动与运行

### 4.1 环境要求

- **Node.js** v18+
- **Python** 3.9+

### 4.2 一键启动

```powershell
.\start.ps1          # 四个服务分窗口启动
```

### 4.3 分步启动（推荐调试用）

```powershell
# 终端 1 — Python 图像特征服务 :8084（必须先启动）
python services/knowledge-ai/python/main.py

# 终端 2 — Node.js 知识库服务 :8083
node services/knowledge-ai/src/index.mjs

# 终端 3 — Node.js 管理中台 :8082
node services/decision-admin/src/index.mjs

# 终端 4 — Node.js BFF 网关 :8080
node services/gateway-bff/src/index.mjs

# 可选 — 决策引擎 :8081
node services/decision-engine/src/index.mjs
```

### 4.4 生产部署（PM2 + Nginx）

```bash
# 安装 PM2
npm install -g pm2

# 启动所有服务
pm2 start ecosystem.config.cjs

# Nginx 反向代理（参考 nginx-site.conf）
```

### 4.5 可选：Milvus 向量数据库

```bash
docker run -d --name milvus-standalone -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest
```

Python 服务启动时自动检测 Milvus，检测到则优先使用，未检测到则回退内存索引。

### 4.6 访问地址

| 地址 | 用途 | 角色 |
|------|------|------|
| `http://localhost:8080/` | H5 鉴定页面 | 一线售后 |
| `http://localhost:8082/admin` | 管理后台 | 导师/管理员 |
| `http://localhost:8083/api/knowledge/vector-stats` | 向量服务状态 | 调试 |

---

## 五、API 接口

### 5.1 案例判定

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

### 5.2 LLM 流式分析（SSE）

```
POST /api/v1/llm/analyze-stream
Content-Type: application/json

{
  "images": ["data:image/jpeg;base64,..."],
  "context": "安装状态：未安装，包装：无损坏"
}
```

响应为 SSE 流式，实时输出鉴定报告。

### 5.3 标注 API (8083)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/knowledge/annotate-single` | 单张图片 AI 标注（返回 JSON 字段） |
| POST | `/api/knowledge/annotate-batch` | 批量图片 AI 标注 |
| GET/POST | `/api/knowledge/annotation-config` | 标注模型配置（模型/提示词/参数） |

### 5.4 知识库 API (8083)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/knowledge/case?id=` | 案例详情 |
| POST | `/api/knowledge/search` | 融合检索（图像+标签） |
| POST | `/api/knowledge/search-vector` | 纯向量检索 |
| POST | `/api/knowledge/rebuild-index` | 触发重建向量库 |
| GET | `/api/knowledge/vector-stats` | 向量服务状态 |
| POST | `/api/knowledge/analyze` | LLM 深度分析 |
| POST | `/api/knowledge/analyze-stream` | LLM 流式分析 (SSE) |
| GET/POST | `/api/knowledge/cases*` | 案例 CRUD |
| POST | `/api/knowledge/cases/batch-delete` | 批量删除 |
| GET/POST | `/api/knowledge/model-config` | 主模型配置 |
| GET/POST | `/api/knowledge/annotation-config` | 标注模型配置 |
| POST | `/api/knowledge/kb/upload` | 知识库文档上传 |
| GET | `/api/knowledge/kb/search` | 知识库检索 |
| POST | `/api/knowledge/correction` | 提交纠错训练数据 |

### 5.5 规则管理 (8082)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/rules` | 规则列表 |
| POST | `/api/admin/rules` | 创建规则 |
| PUT | `/api/admin/rules/update` | 更新规则 |
| POST | `/api/admin/rules/publish` | 发布规则 |

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

## 七、快速标注字段配置

管理后台支持动态配置标注字段，默认包含：

| ID | 标签 | 类型 | 必填 | 选项示例 |
|------|------|:---:|:---:|------|
| `title` | 标题 | input | | |
| `crackLocation` | 屏损位置 | tag-grid | ✓ | 天侧/地侧/左侧/右侧/四角区域/中央区域/全屏区域/局部不规则区域 |
| `crackShape` | 屏损形态 | tag-grid | ✓ | 单条线状屏裂/多条线状屏裂/点放射状屏裂/发散性线状屏裂/环状圈状屏裂/网状屏裂/漏液/熔屏 |
| `crackStage` | 屏损环节 | tag-grid | | 产品因素/物流运输搬运/拆机验机安装/使用保管不当 |
| `result` | 鉴定结论 | result-btns | | 产品质量问题/物流问题/非产品质量问题/需进一步鉴定 |
| `installStatus` | 安装状态 | tag-grid | | 已安装/未安装 |
| `packageDamage` | 包装状态 | tag-grid | | 无损坏/轻微损坏/严重损坏 |
| `crackPrinciple` | 屏损原理 | textarea | | 自由文本（分析为何损坏的成因推断） |

字段可在「管理后台 → 模型配置 → ⚙ 标注字段配置」中自由增删改。

---

## 八、项目文件结构

```
屏损智能体/
├── frontend/
│   └── index.html                     ← H5 单文件 SPA
├── services/
│   ├── shared/
│   │   └── server-utils.mjs           ← 公共 HTTP 工具模块
│   ├── gateway-bff/                   ← :8080 请求聚合 + 前端托管
│   │   └── src/
│   │       ├── index.mjs
│   │       └── server-utils.mjs
│   ├── decision-engine/               ← :8081 决策树判定引擎
│   │   └── src/
│   │       ├── index.mjs
│   │       └── decision-tree.mjs
│   ├── decision-admin/                ← :8082 管理中台
│   │   ├── src/
│   │   │   ├── index.mjs
│   │   │   └── server-utils.mjs
│   │   └── static/admin.html          ← 导师后台 (3000行)
│   └── knowledge-ai/                  ← :8083 知识检索 + 向量融合 + LLM
│       ├── src/
│       │   ├── index.mjs              ← API 路由
│       │   ├── search-engine.mjs      ← 向量融合检索 + 案例 CRUD
│       │   ├── llm-analyzer.mjs       ← LLM 分析 + 标注模型
│       │   ├── knowledge-base.mjs     ← RAG 知识库管理
│       │   └── server-utils.mjs
│       ├── data/
│       │   ├── cases.json             ← 案例库持久化
│       │   ├── training.json          ← 纠错训练数据
│       │   ├── vector-index.json      ← 向量索引持久化
│       │   ├── model-config.json      ← 主模型配置 (含 Key，不入库)
│       │   ├── model-config.template.json ← 模型配置模板
│       │   ├── annotation-config.json ← 标注模型配置 (含 Key，不入库)
│       │   ├── annotation-config.template.json ← 标注配置模板
│       │   ├── knowledge-base.json     ← 知识库文档索引
│       │   └── images/                ← 案例图片 (24张)
│       └── python/
│           └── main.py                ← 图像特征服务 (PIL+Numpy, 512维)
├── ecosystem.config.cjs               ← PM2 生产部署配置
├── nginx-site.conf                    ← Nginx 反向代理配置
├── .gitignore
└── README.md
```

---

## 九、如何提升准确率

1. **积累高质量案例**：在管理后台录入清晰的特征图片 + 准确的标签（crackLocation/crackShape），创建即自动索引
2. **标签准确**：融合分依赖标签匹配（权重 40%），标签越准融合分越可靠
3. **类型覆盖**：每种屏损（漏液/裂纹/冲击点/偏光片划伤）至少 3 个案例
4. **重建索引**：特征算法更新后，在管理后台点击「重建向量库」
5. **标注提示词优化**：在标注模型配置中微调 systemPrompt，让 LLM 输出更精准的成因分析

准确率取决于案例库质量而非模型训练——**创建案例 = 训练**。
