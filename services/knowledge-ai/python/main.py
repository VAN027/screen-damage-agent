"""
屏损智能体 - 图像特征提取与向量检索微服务 v5.0 (DINOv2 版)
=========================================================
使用 DINOv2 ViT-S/14 提取 384 维图像语义特征，Milvus 向量数据库存储与检索。
自动检测 Milvus 可用性，不可用时回退内存索引。

启动方式:
  pip install fastapi uvicorn Pillow numpy httpx torch transformers
  python main.py

前置条件 (可选但推荐):
  docker run -d --name milvus-standalone -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest

API:
  POST /api/knowledge/extract-base64  → 提取图片特征向量 (512维)
  POST /api/knowledge/search           → 以图搜图 (Milvus / 内存回退)
  POST /api/knowledge/index-base64     → 图片特征入向量库
  POST /api/knowledge/index-batch      → 批量入库
  POST /api/knowledge/rebuild-index    → 清空并重建全部向量索引
  DELETE /api/knowledge/index/{case_id} → 删除指定向量
  GET  /api/health                      → 健康检查
  GET  /api/knowledge/stats             → 向量库统计
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
from PIL import Image
import io
import time
import os
import base64
import json
import logging
from pathlib import Path

import httpx
import torch
from transformers import AutoImageProcessor, AutoModel

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="屏损知识检索服务 - Milvus", version="4.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
FEATURE_DIM = 384  # DINOv2 ViT-S/14 CLS token
COLLECTION_NAME = "screen_damage_cases"
MILVUS_HOST = os.getenv("MILVUS_HOST", "localhost")
MILVUS_PORT = int(os.getenv("MILVUS_PORT", "19530"))
MILVUS_REST_PORT = int(os.getenv("MILVUS_REST_PORT", "9091"))
MILVUS_REST_URL = f"http://{MILVUS_HOST}:{MILVUS_REST_PORT}/v2/vectordb"

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
INDEX_FILE = DATA_DIR / "vector-index.json"
start_time = time.time()

# ---------------------------------------------------------------------------
# 内存回退向量索引
# ---------------------------------------------------------------------------
memory_index = {}

def _load_memory_index():
    global memory_index
    if INDEX_FILE.exists():
        try:
            with open(INDEX_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            memory_index = {}
            for k, v in data.items():
                v["vector"] = np.array(v["vector"], dtype=np.float32)
                memory_index[k] = v
            logger.info(f"已加载 {len(memory_index)} 条内存向量索引")
        except Exception as e:
            logger.warning(f"加载内存索引失败: {e}")

def _save_memory_index():
    data = {}
    for k, v in memory_index.items():
        data[k] = {
            "vector": v["vector"].tolist(),
            "meta": v.get("meta", {}),
            "created_at": v.get("created_at", 0),
        }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

# ---------------------------------------------------------------------------
# Milvus 连接管理
# ---------------------------------------------------------------------------
milvus_available = False
_httpx_client = None

def _get_client():
    global _httpx_client
    if _httpx_client is None:
        _httpx_client = httpx.Client(timeout=httpx.Timeout(10.0))
    return _httpx_client

def _milvus_api(method: str, path: str, json_data: dict = None):
    """调用 Milvus RESTful API v2"""
    client = _get_client()
    url = f"{MILVUS_REST_URL}{path}"
    req = client.build_request(method, url, json=json_data)
    resp = client.send(req)
    if resp.status_code >= 400:
        raise RuntimeError(f"Milvus API {method} {path} 失败 ({resp.status_code}): {resp.text[:300]}")
    return resp.json()

async def check_milvus():
    """检测 Milvus 是否可用，并确保 collection 存在"""
    global milvus_available
    try:
        # 尝试列出 collections
        resp = _milvus_api("POST", "/collections/list")
        collections = [c.get("collectionName", c.get("collection_name", ""))
                       for c in resp.get("data", resp.get("collections", []))]

        if COLLECTION_NAME not in collections:
            # 创建 collection
            _milvus_api("POST", "/collections/create", {
                "collectionName": COLLECTION_NAME,
                "dimension": FEATURE_DIM,
                "metricType": "COSINE",
                "primaryField": "id",
                "vectorField": "vector",
                "autoId": False,
            })
            # 创建索引
            _milvus_api("POST", "/indexes/create", {
                "collectionName": COLLECTION_NAME,
                "indexParams": [
                    {"fieldName": "vector", "indexName": "vector_idx",
                     "metricType": "COSINE"}
                ]
            })
            # 加载 collection 到内存
            _milvus_api("POST", "/collections/load", {
                "collectionName": COLLECTION_NAME
            })
            logger.info(f"Milvus 集合 '{COLLECTION_NAME}' 已创建并加载")

        milvus_available = True
        logger.info("Milvus 连接成功")
        return True
    except Exception as e:
        milvus_available = False
        logger.warning(f"Milvus 不可用，使用内存回退: {e}")
        return False

# ---------------------------------------------------------------------------
# 图像特征提取 (DINOv2 ViT-S/14)
# ---------------------------------------------------------------------------

_dinov2_processor = None
_dinov2_model = None

def _get_dinov2():
    global _dinov2_processor, _dinov2_model
    if _dinov2_model is None:
        logger.info("[DINOv2] 加载 facebook/dinov2-small 模型...")
        # 模型已离线缓存，使用 local_files_only 避免访问被墙的 HuggingFace
        _dinov2_processor = AutoImageProcessor.from_pretrained('facebook/dinov2-small', local_files_only=True)
        _dinov2_model = AutoModel.from_pretrained('facebook/dinov2-small', local_files_only=True)
        _dinov2_model.eval()
        logger.info("[DINOv2] 模型加载完成")
    return _dinov2_processor, _dinov2_model

def _decode_image(image_base64: str) -> Image.Image:
    if image_base64.startswith("data:"):
        image_base64 = image_base64.split(",", 1)[1]
    raw = base64.b64decode(image_base64)
    return Image.open(io.BytesIO(raw)).convert("RGB")

def extract_features(img: Image.Image) -> np.ndarray:
    processor, model = _get_dinov2()
    inputs = processor(images=img, return_tensors="pt")
    with torch.no_grad():
        outputs = model(**inputs)
    vec = outputs.last_hidden_state[:, 0, :].cpu().numpy()[0]  # CLS token (384d)
    # L2 归一化
    norm = np.linalg.norm(vec)
    if norm > 0:
        vec = vec / norm
    return vec.astype(np.float32)

def cosine_similarity(vec_a: np.ndarray, vec_b: np.ndarray) -> float:
    return float(np.dot(vec_a, vec_b))

# ---------------------------------------------------------------------------
# 向量操作 抽象层（Milvus / 内存回退）
# ---------------------------------------------------------------------------

async def _search_vectors(query_vec: np.ndarray, top_k: int = 5, exclude_case_id: str = ""):
    if milvus_available:
        try:
            resp = _milvus_api("POST", "/entities/search", {
                "collectionName": COLLECTION_NAME,
                "data": [query_vec.tolist()],
                "annsField": "vector",
                "limit": top_k + (1 if exclude_case_id else 0),
                "outputFields": ["*"],
                "metricType": "COSINE",
            })
            results = []
            for hit in resp.get("data", []):
                for r in hit if isinstance(hit, list) else [hit]:
                    cid = r.get("id", "")
                    if cid == exclude_case_id:
                        continue
                    results.append({
                        "case_id": cid,
                        "similarity": round(r.get("distance", 0), 4),
                        "meta": {k: v for k, v in r.items() if k not in ("id", "vector", "distance")},
                    })
                    if len(results) >= top_k:
                        break
                if len(results) >= top_k:
                    break
            return results
        except Exception as e:
            logger.error(f"Milvus 搜索失败，回退内存: {e}")

    # 内存回退
    scores = []
    for case_id, entry in memory_index.items():
        if case_id == exclude_case_id:
            continue
        sim = cosine_similarity(query_vec, entry["vector"])
        scores.append((case_id, sim, entry.get("meta", {})))
    scores.sort(key=lambda x: x[1], reverse=True)
    return [{"case_id": cid, "similarity": round(s, 4), "meta": m} for cid, s, m in scores[:top_k]]

async def _index_vector(case_id: str, vec: np.ndarray, meta: dict):
    global milvus_available
    if milvus_available:
        try:
            _milvus_api("POST", "/entities/insert", {
                "collectionName": COLLECTION_NAME,
                "data": [{
                    "id": case_id,
                    "vector": vec.tolist(),
                    **meta,
                }]
            })
        except Exception as e:
            logger.error(f"Milvus 插入失败，回退内存: {e}")
            milvus_available = False

    # 内存回退
    memory_index[case_id] = {"vector": vec, "meta": meta, "created_at": time.time()}
    _save_memory_index()

async def _index_batch(items: list):
    count = 0
    for item in items:
        await _index_vector(item["case_id"], item["vector"], item.get("meta", {}))
        count += 1
    return count

async def _delete_vector(case_id: str):
    if milvus_available:
        try:
            _milvus_api("POST", "/entities/delete", {
                "collectionName": COLLECTION_NAME,
                "filter": f'id == "{case_id}"',
            })
        except Exception as e:
            logger.error(f"Milvus 删除失败: {e}")

    if case_id in memory_index:
        del memory_index[case_id]
        _save_memory_index()

async def _get_total_count():
    if milvus_available:
        try:
            resp = _milvus_api("POST", "/collections/describe", {
                "collectionName": COLLECTION_NAME
            })
            return resp.get("data", {}).get("numEntities", resp.get("data", {}).get("num_entities", 0))
        except:
            pass
    return len(memory_index)

async def _rebuild_index(items: list):
    if milvus_available:
        try:
            _milvus_api("POST", "/collections/drop", {"collectionName": COLLECTION_NAME})
        except:
            pass
        await check_milvus()

    global memory_index
    memory_index = {}
    for item in items:
        await _index_vector(item["case_id"], item["vector"], item.get("meta", {}))
    return await _get_total_count()

# ---------------------------------------------------------------------------
# API 模型
# ---------------------------------------------------------------------------

class ExtractRequest(BaseModel):
    image_base64: str

class SearchRequest(BaseModel):
    image_base64: str
    top_k: int = 5
    exclude_case_id: str = ""

class IndexRequest(BaseModel):
    case_id: str
    image_base64: str
    symptoms: str = ""
    result_label: str = ""
    crack_location: str = ""
    crack_shape: str = ""

class BatchIndexItem(BaseModel):
    case_id: str
    image_base64: str
    symptoms: str = ""
    result_label: str = ""
    crack_location: str = ""
    crack_shape: str = ""

class RebuildRequest(BaseModel):
    items: List[BatchIndexItem] = []

# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": "DINOv2-ViT-S/14 (384-dim)",
        "milvus_connected": milvus_available,
        "indexed_vectors": await _get_total_count(),
        "engine": "Milvus" if milvus_available else "numpy-cosine (fallback)",
        "uptime": time.time() - start_time,
    }

@app.get("/api/knowledge/stats")
async def stats():
    return {
        "total_vectors": await _get_total_count(),
        "dimension": FEATURE_DIM,
        "engine": "Milvus REST API" if milvus_available else "numpy cosine similarity (fallback)",
    }

@app.post("/api/knowledge/extract-base64")
async def extract(request: ExtractRequest):
    try:
        img = _decode_image(request.image_base64)
        vec = extract_features(img)
        return {"vector": vec.tolist(), "model": "dinov2-small", "dim": FEATURE_DIM}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"特征提取失败: {e}")

@app.post("/api/knowledge/search")
async def search(request: SearchRequest):
    try:
        img = _decode_image(request.image_base64)
        query_vec = extract_features(img)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片处理失败: {e}")

    results = await _search_vectors(query_vec, request.top_k, request.exclude_case_id)
    return {
        "results": results,
        "total_hits": len(results),
        "engine": "Milvus" if milvus_available else "numpy-cosine",
        "vector_dim": FEATURE_DIM,
    }

@app.post("/api/knowledge/index-base64")
async def index(request: IndexRequest):
    try:
        img = _decode_image(request.image_base64)
        vec = extract_features(img)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片处理失败: {e}")

    meta = {
        "symptoms": request.symptoms,
        "result_label": request.result_label,
        "crack_location": request.crack_location,
        "crack_shape": request.crack_shape,
    }
    await _index_vector(request.case_id, vec, meta)
    logger.info(f"索引向量: {request.case_id}")
    return {"status": "ok", "case_id": request.case_id}

@app.post("/api/knowledge/index-batch")
async def index_batch(items: List[BatchIndexItem]):
    batch_items = []
    for item in items:
        try:
            img = _decode_image(item.image_base64)
            vec = extract_features(img)
            batch_items.append({
                "case_id": item.case_id,
                "vector": vec,
                "meta": {
                    "symptoms": item.symptoms,
                    "result_label": item.result_label,
                    "crack_location": item.crack_location,
                    "crack_shape": item.crack_shape,
                }
            })
        except Exception as e:
            logger.error(f"索引失败 {item.case_id}: {e}")

    count = await _index_batch(batch_items)
    logger.info(f"批量索引: {count} 条")
    return {"status": "ok", "indexed": count, "total": await _get_total_count()}

@app.delete("/api/knowledge/index/{case_id}")
async def delete_index(case_id: str):
    await _delete_vector(case_id)
    logger.info(f"删除向量: {case_id}")
    return {"status": "ok"}

@app.post("/api/knowledge/rebuild-index")
async def rebuild_index(request: RebuildRequest):
    batch_items = []
    for item in request.items:
        try:
            img = _decode_image(item.image_base64)
            vec = extract_features(img)
            batch_items.append({
                "case_id": item.case_id,
                "vector": vec,
                "meta": {
                    "symptoms": item.symptoms,
                    "result_label": item.result_label,
                    "crack_location": item.crack_location,
                    "crack_shape": item.crack_shape,
                }
            })
        except Exception as e:
            logger.error(f"重建索引失败 {item.case_id}: {e}")

    total = await _rebuild_index(batch_items)
    logger.info(f"重建索引完成: {total} 条")
    return {"status": "ok", "indexed": total}

# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    _load_memory_index()
    await check_milvus()
    mode = "Milvus REST API" if milvus_available else "内存索引 (numpy cosine)"
    logger.info(f"向量存储引擎: {mode}")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("CLIP_PORT", "8084"))
    logger.info(f"启动图像特征服务 → http://0.0.0.0:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
