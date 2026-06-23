# 屏损故障鉴定智能体

> **版本**：v5.0 | **更新**：2026-06-12

---

## 一、系统概述

屏损智能体是一套面向 TCL 一线售后人员的智能鉴定系统。售后人员在现场遇到屏幕故障时，通过手机 H5 完成「症状采集 → 拍照取证 → 物理触感检测 → 安装信息录入」，系统**自动以图像向量检索匹配历史案例** + 决策树判定故障责任归属，并输出相似案例供现场比对。

核心亮点：
- **向量检索**：512维图像特征（色阶直方图 + 分块均值 + Sobel边缘 + LBP纹理）→ 余弦相似度匹配
- **搜索融合**：图像相似度(60%) + 标签匹配(40%) 加权融合，准确率远超纯标签匹配
- **自动索引**：创建/导入案例时自动提取特征写入向量库，无需手动训练
- **管理后台**：案例库 CRUD + 批量图片入库 + 一键重建向量索引 + 规则发布
- **运行时零外部依赖**（Node.js + Python 内置模块）

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
│  前端托管 + 请求聚合 + API 代理                            │
└──┬───────────┬──────────────┬───────────────────────────┘
   │           │              │
   ▼           ▼              ▼
┌─────────┐ ┌────────────┐ ┌───────────────────────┐
│engine   │ │knowledge-ai│ │decision-admin          │
│:8081    │ │:8083       │ │:8082                   │
│Node.js  │ │Node.js     │ │Node.js                  │
│         │ │            │ │                        │
│决策树   │ │向量+标签    │ │案例管理 + 批量导入       │
│判定引擎 │ │融合检索     │ │向量索引重建 + 规则管理   │
│置信度   │ │LLM分析     │ │JSON持久化                │
│打分机制 │ │            │ │                        │
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
| **gateway-bff** | 8080 | 前端托管 + 请求聚合 + API 代理 |
| **decision-engine** | 8081 | 决策树判定引擎 + 置信度打分 |
| **decision-admin** | 8082 | 管理中台（案例库 + 向量索引 + 规则） |
| **knowledge-ai** | 8083 | 知识检索 + 向量融合匹配 + LLM分析 |
| **python-features** | 8084 | 图像特征提取 (PIL+Numpy, 512维) |

---

## 三、功能清单

### 3.1 一线售后 — 手机端 H5

访问：**`http://localhost:8080/`**

| 步骤 | 功能 | 操作 |
|:---:|------|------|
| ① | 症状初筛：5 种屏损类型可视化卡片，多选 | 点击卡片 |
| ② | 拍照取证：调用摄像头（后置优先），自动叠加水印 | 点击「📷 拍照」 |
| ② | 微距引导：白色虚线框 + 提示，强制对焦 | 点击「微距辅助线」 |
| ③ | 物理触感：凹凸感/内屏裂痕 | 开关选择 |
| ④ | 安装信息：安装状态/开箱人员/包装/故障环节 | 下拉 + 多选 |
| ⑤ | 判定结果：结论卡片 + 置信度 + 判定路径回溯 | 自动展示 |
| ⑤ | 相似案例：**向量+标签融合匹配**，Top 5 推荐 | 自动加载 |

### 3.2 管理后台

访问：**`http://localhost:8082/admin`**

| 模块 | 功能 |
|------|------|
| **案例库** | 案例 CRUD、批量图片入库、JSON 批量导入/导出 |
| **向量索引** | 一键重建向量库、查看引擎状态 |
| **规则管理** | 决策树可视化编辑、版本发布/回滚、JSON 校验 |
| **模型配置** | LLM 大模型接口配置、知识库上传、向量服务状态 |

### 3.3 向量检索

| 特性 | 说明 |
|------|------|
| **特征维度** | 512 维：色阶(128) + 分块均值(128) + Sobel边缘(128) + LBP纹理(128) |
| **相似度算法** | L2归一化 → 余弦相似度（点积） |
| **融合得分** | 图像相似度 × 0.6 + 标签匹配 × 0.4 |
| **匹配阈值** | ≥80% 覆盖自动分析结论 / ≥70% 高亮推荐 / <50% 过滤 |
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

或双击 `start.bat`

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

### 4.4 停止服务

```powershell
.\stop.bat
```

### 4.5 可选：Milvus 向量数据库

```bash
docker run -d --name milvus-standalone -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest
```

Python 服务启动时自动检测 Milvus，检测到则优先使用，未检测到则回退内存索引。**功能完全相同**，内存模式适合案例量 < 万级。

### 4.6 访问地址

| 地址 | 用途 | 角色 |
|------|------|------|
| `http://localhost:8080/` | H5 鉴定页面 | 一线售后 |
| `http://localhost:8082/admin` | 管理后台 | 导师 |
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

响应：

```json
{
  "success": true,
  "data": {
    "caseId": "CASE-1780400000000-abc123",
    "decision": {
      "result": "product_quality_issue",
      "resultLabel": "产品质量问题",
      "confidence": 77,
      "needExpertReview": false,
      "decisionPath": [ ... ],
      "ruleVersion": "1.0"
    }
  }
}
```

### 5.2 相似案例检索（带图像向量融合）

```
POST /api/v1/cases/search-similar

{
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQ...",
  "symptoms": ["dot_star"],
  "crackShape": "蛛网状",
  "physicalFeature": "有凹坑",
  "topK": 5
}
```

响应包含 `similarity`（融合分）、`vecSimilarity`、`labelSimilarity`，案例结论 (`possibleCause`) 和保修建议 (`warrantyTip`)。

### 5.3 向量服务 API (8084)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 服务状态（Milvus可用性、已索引向量数） |
| POST | `/api/knowledge/extract-base64` | 提取图片 512 维特征向量 |
| POST | `/api/knowledge/index-base64` | 提取特征并索引到向量库 |
| POST | `/api/knowledge/index-batch` | 批量索引 |
| POST | `/api/knowledge/search-base64` | 以图搜图（余弦相似度 Top-K） |
| POST | `/api/knowledge/rebuild-index` | 从案例库重建全部向量索引 |
| DELETE | `/api/knowledge/delete` | 删除指定案例的向量 |

### 5.4 知识库 API (8083)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/knowledge/case?id=` | 案例详情 |
| POST | `/api/knowledge/search` | 融合检索（图像+标签） |
| POST | `/api/knowledge/search-vector` | 纯向量检索 |
| POST | `/api/knowledge/rebuild-index` | 触发重建向量库 |
| GET | `/api/knowledge/vector-stats` | 向量服务状态 |
| POST | `/api/knowledge/analyze` | LLM 深度分析 |
| GET/POST | `/api/knowledge/cases*` | 案例 CRUD |

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

## 七、项目文件结构

```
屏损智能体/
├── frontend/
│   └── index.html                     ← H5 单文件 SPA
├── services/
│   ├── gateway-bff/                   ← :8080 请求聚合 + 前端托管
│   │   └── src/
│   ├── decision-engine/               ← :8081 决策树判定引擎
│   │   └── src/
│   ├── decision-admin/                ← :8082 管理中台
│   │   ├── src/
│   │   └── static/admin.html          ← 导师后台
│   └── knowledge-ai/                  ← :8083 知识检索 + 向量融合
│       ├── src/
│       │   ├── index.mjs
│       │   ├── search-engine.mjs      ← 向量融合检索 + 案例 CRUD
│       │   ├── clip-client.mjs        ← Python 特征服务 HTTP 客户端
│       │   └── llm-analyzer.mjs       ← LLM 分析
│       ├── data/
│       │   ├── cases.json             ← 案例库持久化
│       │   ├── vector-index.json      ← 向量索引持久化
│       │   └── model-config.json      ← LLM 配置
│       └── python/
│           └── main.py                ← 图像特征服务 (PIL+Numpy, 512维)
├── start.ps1 / start.bat              ← 一键启动
├── stop.bat                           ← 一键停止
└── README.md
```

---

## 八、如何提升准确率

1. **积累高质量案例**：在管理后台录入清晰的特征图片 + 准确的标签（crackLocation/crackShape），创建即自动索引
2. **标签准确**：融合分依赖标签匹配（权重 40%），标签越准融合分越可靠
3. **类型覆盖**：每种屏损（漏液/裂纹/冲击点/偏光片划伤）至少 3 个案例
4. **重建索引**：特征算法更新后，在管理后台点击「重建向量库」

准确率取决于案例库质量而非模型训练——**创建案例 = 训练**。
