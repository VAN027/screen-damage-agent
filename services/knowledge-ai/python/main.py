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
  POST /api/knowledge/extract-base64  → 提取图片特征向量 (384维)
  POST /api/knowledge/search           → 以图搜图 (Milvus / 内存回退)
  POST /api/knowledge/index-base64     → 图片特征入向量库
  POST /api/knowledge/index-batch      → 批量入库
  POST /api/knowledge/rebuild-index    → 清空并重建全部向量索引
  DELETE /api/knowledge/index/{case_id} → 删除指定向量
  GET  /api/health                      → 健康检查
  GET  /api/knowledge/stats             → 向量库统计
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from typing import List, Optional
import numpy as np
from PIL import Image
import io
import time
import os
import base64
import json
import logging
import hmac
import re
import warnings
from pathlib import Path

import httpx
import torch
from transformers import AutoImageProcessor, AutoModel
from orientation import detect_tv_orientation

logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="屏损知识检索服务 - Milvus", version="5.0.0")

MAX_IMAGE_BASE64_CHARS = 14 * 1024 * 1024
MAX_IMAGE_DECODED_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_IMAGE_DIMENSION = 8192
MAX_SINGLE_REQUEST_BYTES = 15 * 1024 * 1024
MAX_BATCH_REQUEST_BYTES = 64 * 1024 * 1024
IMAGE_DATA_URL_RE = re.compile(
    r"^data:image/(?:jpeg|jpg|png|webp|gif|bmp|avif);base64,([A-Za-z0-9+/]+={0,2})$",
    re.IGNORECASE,
)
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

@app.middleware("http")
async def require_internal_token(request: Request, call_next):
    """8084 仅健康检查可匿名访问；业务端点始终 fail closed。"""
    if request.url.path == "/api/health":
        return await call_next(request)

    expected = os.getenv("INTERNAL_SERVICE_TOKEN", "")
    if not expected:
        return JSONResponse(
            status_code=503,
            content={"detail": "向量服务未配置 INTERNAL_SERVICE_TOKEN"},
        )

    provided = request.headers.get("X-Internal-Token", "")
    if not hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        return JSONResponse(status_code=401, content={"detail": "内部服务凭据无效"})

    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Content-Length 无效"})
        batch_paths = {"/api/knowledge/index-batch", "/api/knowledge/rebuild-index"}
        body_limit = MAX_BATCH_REQUEST_BYTES if request.url.path in batch_paths else MAX_SINGLE_REQUEST_BYTES
        if declared_size < 0 or declared_size > body_limit:
            return JSONResponse(status_code=413, content={"detail": "请求体超过大小限制"})
    return await call_next(request)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
FEATURE_DIM = 384  # DINOv2 ViT-S/14 CLS token
COLLECTION_NAME = "screen_damage_cases"
MILVUS_HOST = os.getenv("MILVUS_HOST", "localhost")
MILVUS_PORT = int(os.getenv("MILVUS_PORT", "19530"))
MILVUS_REST_PORT = int(os.getenv("MILVUS_REST_PORT", "9091"))
MILVUS_REST_URL = f"http://{MILVUS_HOST}:{MILVUS_REST_PORT}/v2/vectordb"
DINO_MODEL_NAME = os.getenv("DINO_MODEL_NAME", "facebook/dinov2-small")

def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")

# 显式配置优先；未配置时遵循 HuggingFace 的离线模式开关。
DINO_LOCAL_FILES_ONLY = _env_bool(
    "DINO_LOCAL_FILES_ONLY",
    _env_bool("HF_HUB_OFFLINE", False),
)

_default_data_dir = Path(__file__).resolve().parent.parent / "data"
DATA_DIR = Path(os.getenv("VECTOR_DATA_DIR", str(_default_data_dir))).expanduser().resolve()
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
                vector = np.array(v["vector"], dtype=np.float32)
                if vector.ndim != 1 or vector.shape[0] != FEATURE_DIM:
                    logger.warning(
                        "跳过维度不兼容的旧向量 %s: expected=%s actual=%s",
                        k,
                        FEATURE_DIM,
                        vector.shape,
                    )
                    continue
                v["vector"] = vector
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
    # 先写临时文件再原子替换，避免进程中断留下半截 JSON。
    temp_file = INDEX_FILE.with_suffix(INDEX_FILE.suffix + ".tmp")
    with open(temp_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(temp_file, INDEX_FILE)

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
        logger.info(
            "[DINOv2] 加载模型 %s (local_files_only=%s)...",
            DINO_MODEL_NAME,
            DINO_LOCAL_FILES_ONLY,
        )
        _dinov2_processor = AutoImageProcessor.from_pretrained(
            DINO_MODEL_NAME,
            local_files_only=DINO_LOCAL_FILES_ONLY,
        )
        _dinov2_model = AutoModel.from_pretrained(
            DINO_MODEL_NAME,
            local_files_only=DINO_LOCAL_FILES_ONLY,
        )
        _dinov2_model.eval()
        logger.info("[DINOv2] 模型加载完成")
    return _dinov2_processor, _dinov2_model

def _decode_image(image_base64: str) -> Image.Image:
    if not isinstance(image_base64, str) or not image_base64:
        raise ValueError("图片数据不能为空")

    if image_base64.startswith("data:"):
        match = IMAGE_DATA_URL_RE.fullmatch(image_base64)
        if not match:
            raise ValueError("图片 data URL 格式不受支持")
        payload = match.group(1)
    else:
        payload = image_base64

    if len(payload) > MAX_IMAGE_BASE64_CHARS:
        raise ValueError("图片 Base64 超过大小限制")
    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise ValueError("图片 Base64 编码无效") from exc
    if not raw or len(raw) > MAX_IMAGE_DECODED_BYTES:
        raise ValueError("图片解码后超过大小限制")

    # verify() 检查文件结构；随后重新打开并在分配完整像素缓冲前检查尺寸。
    with Image.open(io.BytesIO(raw)) as probe:
        probe.verify()
    with Image.open(io.BytesIO(raw)) as source:
        width, height = source.size
        if width <= 0 or height <= 0:
            raise ValueError("图片尺寸无效")
        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
            raise ValueError("图片像素尺寸超过限制")
        source.load()
        return source.convert("RGB")

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
    return await _index_batch([{
        "case_id": case_id,
        "vector": vec,
        "meta": meta,
    }])

async def _index_batch(items: list):
    """批量 upsert，并且仅在整批完成后持久化一次内存回退索引。"""
    global milvus_available
    if not items:
        return 0

    if milvus_available:
        try:
            _milvus_api("POST", "/entities/upsert", {
                "collectionName": COLLECTION_NAME,
                "data": [{
                    "id": item["case_id"],
                    "vector": item["vector"].tolist(),
                    **item.get("meta", {}),
                } for item in items],
            })
        except Exception as e:
            logger.error(f"Milvus 批量写入失败，回退内存: {e}")
            milvus_available = False

    now = time.time()
    for item in items:
        memory_index[item["case_id"]] = {
            "vector": item["vector"],
            "meta": item.get("meta", {}),
            "created_at": now,
        }
    _save_memory_index()
    return len(items)

async def _delete_vector(case_id: str):
    return await _delete_vectors([case_id])

async def _delete_vectors(case_ids: list):
    """批量删除向量；内存索引只刷盘一次，并把主存储失败显式返回。"""
    global milvus_available
    unique_ids = list(dict.fromkeys(str(cid) for cid in case_ids if cid))
    if not unique_ids:
        return {"requested": 0, "deleted": 0, "failed": 0, "errors": []}

    errors = []
    if milvus_available:
        try:
            id_list = ", ".join(json.dumps(cid, ensure_ascii=False) for cid in unique_ids)
            _milvus_api("POST", "/entities/delete", {
                "collectionName": COLLECTION_NAME,
                "filter": f"id in [{id_list}]",
            })
        except Exception as e:
            logger.error(f"Milvus 批量删除失败: {e}")
            errors.append(str(e))
            # 主存储中可能仍有脏数据，立即切换到已完成清理的内存索引。
            milvus_available = False

    memory_deleted = 0
    for case_id in unique_ids:
        if case_id in memory_index:
            del memory_index[case_id]
            memory_deleted += 1
    if memory_deleted:
        _save_memory_index()

    return {
        "requested": len(unique_ids),
        "deleted": memory_deleted,
        "failed": len(unique_ids) if errors else 0,
        "errors": errors,
    }

async def _get_total_count():
    if milvus_available:
        try:
            resp = _milvus_api("POST", "/collections/describe", {
                "collectionName": COLLECTION_NAME
            })
            data = resp.get("data", {})
            count = data.get("numEntities", data.get("num_entities"))
            if count is not None:
                return int(count)
        except Exception as e:
            logger.warning(f"读取 Milvus 向量数量失败，使用内存镜像计数: {e}")
    return len(memory_index)

async def _rebuild_index(items: list):
    global memory_index, milvus_available
    if milvus_available:
        try:
            _milvus_api("POST", "/collections/drop", {"collectionName": COLLECTION_NAME})
        except Exception as e:
            # 未确认清空成功时不能向旧集合追加，否则会混入陈旧向量。
            raise RuntimeError(f"清空 Milvus 集合失败: {e}") from e

        # drop 已成功，主存储和内存回退都应立即视为空。
        memory_index = {}
        _save_memory_index()
        if not await check_milvus():
            raise RuntimeError("Milvus 集合已清空，但重新创建失败")

    memory_index = {}
    if not items:
        _save_memory_index()
        return 0
    return await _index_batch(items)

# ---------------------------------------------------------------------------
# API 模型
# ---------------------------------------------------------------------------

class ExtractRequest(BaseModel):
    image_base64: str = Field(max_length=MAX_IMAGE_BASE64_CHARS + 64)

class OrientationRequest(BaseModel):
    image_base64: str = Field(max_length=MAX_IMAGE_BASE64_CHARS + 64)
    use_ocr: bool = True

class SearchRequest(BaseModel):
    image_base64: str = Field(max_length=MAX_IMAGE_BASE64_CHARS + 64)
    top_k: int = Field(default=5, ge=1, le=20)
    exclude_case_id: str = Field(default="", max_length=128)

class IndexRequest(BaseModel):
    case_id: str = Field(min_length=1, max_length=128)
    image_base64: str = Field(max_length=MAX_IMAGE_BASE64_CHARS + 64)
    symptoms: str = Field(default="", max_length=2000)
    result_label: str = Field(default="", max_length=100)
    crack_location: str = Field(default="", max_length=100)
    crack_shape: str = Field(default="", max_length=500)

class BatchIndexItem(BaseModel):
    case_id: str = Field(min_length=1, max_length=128)
    image_base64: str = Field(max_length=MAX_IMAGE_BASE64_CHARS + 64)
    symptoms: str = Field(default="", max_length=2000)
    result_label: str = Field(default="", max_length=100)
    crack_location: str = Field(default="", max_length=100)
    crack_shape: str = Field(default="", max_length=500)

class RebuildRequest(BaseModel):
    items: List[BatchIndexItem] = Field(default_factory=list, max_length=50)

class DeleteBatchRequest(BaseModel):
    case_ids: List[str] = Field(default_factory=list, max_length=1000)

# ---------------------------------------------------------------------------
# API 端点
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "model": f"{DINO_MODEL_NAME} ({FEATURE_DIM}-dim)",
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

@app.post("/api/knowledge/orientation")
async def orientation(request: OrientationRequest):
    """Detect TV long-axis orientation and compare 0/180-degree OCR evidence."""
    try:
        img = _decode_image(request.image_base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"方向检测图片处理失败: {exc}") from exc

    try:
        # OpenCV and Paddle inference are blocking; keep them off the ASGI event loop.
        return await run_in_threadpool(detect_tv_orientation, img, request.use_ocr)
    except Exception as exc:
        logger.exception("电视方向检测失败")
        raise HTTPException(status_code=500, detail=f"电视方向检测失败: {exc}") from exc

@app.post("/api/knowledge/extract-base64")
async def extract(request: ExtractRequest):
    try:
        img = _decode_image(request.image_base64)
        vec = extract_features(img)
        return {"vector": vec.tolist(), "model": DINO_MODEL_NAME, "dim": FEATURE_DIM}
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
    indexed = await _index_vector(request.case_id, vec, meta)
    logger.info(f"索引向量: {request.case_id}")
    return {
        "status": "ok",
        "case_id": request.case_id,
        "indexed": indexed,
        "total_vectors": len(memory_index),
    }

@app.post("/api/knowledge/index-batch")
async def index_batch(items: List[BatchIndexItem]):
    batch_items = []
    errors = []
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
            errors.append({"case_id": item.case_id, "error": str(e)})

    count = await _index_batch(batch_items)
    logger.info(f"批量索引: {count} 条")
    return {
        "status": "ok" if not errors else "partial",
        "indexed": count,
        "failed": len(errors),
        "errors": errors,
        "total_vectors": len(memory_index),
    }

@app.delete("/api/knowledge/index/{case_id}")
async def delete_index(case_id: str):
    result = await _delete_vector(case_id)
    logger.info(f"删除向量: {case_id}")
    return {"status": "ok" if not result["errors"] else "partial", **result}

@app.post("/api/knowledge/delete-batch")
async def delete_index_batch(request: DeleteBatchRequest):
    result = await _delete_vectors(request.case_ids)
    logger.info(f"批量删除向量: {result['requested']} 条")
    return {
        "status": "ok" if not result["errors"] else "partial",
        **result,
        "total_vectors": len(memory_index),
    }

@app.post("/api/knowledge/rebuild-index")
async def rebuild_index(request: RebuildRequest):
    batch_items = []
    errors = []
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
            errors.append({"case_id": item.case_id, "error": str(e)})

    indexed = await _rebuild_index(batch_items)
    logger.info(f"重建索引完成: {indexed} 条")
    return {
        "status": "ok" if not errors else "partial",
        "indexed": indexed,
        "failed": len(errors),
        "errors": errors,
        # 重建已先清空旧索引，因此本次成功数就是精确的新索引总数。
        "total_vectors": indexed,
    }

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
    host = os.getenv("SERVICE_HOST", "127.0.0.1")
    logger.info(f"启动图像特征服务 → http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
