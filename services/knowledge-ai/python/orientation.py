"""TV orientation detection used by the long-running image service.

The detector deliberately separates the two questions involved in orientation:
1. geometry decides whether the TV long axis is vertical (0/90 degrees);
2. OCR compares the same, already-horizontal TV ROI at 0 and 180 degrees.

When either decision is weak, the caller receives an explicit confirmation flag.
It never infers TV orientation from the aspect ratio of the whole photograph.
"""

from __future__ import annotations

import math
import os
import re
import threading
from typing import Any

import cv2
import numpy as np
from PIL import Image


os.environ.setdefault("PADDLE_PDX_CACHE_HOME", "/models/paddlex")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

MAX_DETECTION_DIMENSION = 1280
GEOMETRY_AUTO_THRESHOLD = 0.62
OCR_AUTO_THRESHOLD = 0.64

_OCR_READER = None
_OCR_LOCK = threading.Lock()
_TEXT_RE = re.compile(r"[A-Za-z0-9\u3400-\u9fff]")


def _order_points(points: np.ndarray) -> np.ndarray:
    """Return corners in top-left, top-right, bottom-right, bottom-left order."""
    points = np.asarray(points, dtype=np.float32)
    ordered = np.zeros((4, 2), dtype=np.float32)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).reshape(-1)
    ordered[0] = points[np.argmin(sums)]
    ordered[2] = points[np.argmax(sums)]
    ordered[1] = points[np.argmin(diffs)]
    ordered[3] = points[np.argmax(diffs)]
    return ordered


def _edge_lengths(ordered: np.ndarray) -> tuple[float, float]:
    tl, tr, br, bl = ordered
    horizontal = max(float(np.linalg.norm(tr - tl)), float(np.linalg.norm(br - bl)))
    vertical = max(float(np.linalg.norm(bl - tl)), float(np.linalg.norm(br - tr)))
    return horizontal, vertical


def _detect_tv_rectangle(bgr: np.ndarray) -> dict[str, Any] | None:
    source_h, source_w = bgr.shape[:2]
    scale = min(1.0, MAX_DETECTION_DIMENSION / max(source_w, source_h))
    if scale < 1.0:
        work = cv2.resize(bgr, (round(source_w * scale), round(source_h * scale)), interpolation=cv2.INTER_AREA)
    else:
        work = bgr

    height, width = work.shape[:2]
    image_area = float(width * height)
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median = float(np.median(blurred))
    low = max(20, int(median * 0.55))
    high = min(220, max(low + 30, int(median * 1.45)))
    edges = cv2.Canny(blurred, low, high)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    joined = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(joined, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[dict[str, Any]] = []
    border_margin = max(4.0, min(width, height) * 0.012)
    image_center = np.array([width / 2.0, height / 2.0], dtype=np.float32)

    for contour in contours:
        contour_area = float(cv2.contourArea(contour))
        if contour_area < image_area * 0.06:
            continue

        rect = cv2.minAreaRect(contour)
        (_, _), (rect_w, rect_h), _ = rect
        if rect_w < 30 or rect_h < 30:
            continue
        rect_area = float(rect_w * rect_h)
        area_ratio = rect_area / image_area
        if area_ratio < 0.08 or area_ratio > 1.03:
            continue

        box = cv2.boxPoints(rect).astype(np.float32)
        ordered = _order_points(box)
        side_a, side_b = _edge_lengths(ordered)
        long_side = max(side_a, side_b)
        short_side = min(side_a, side_b)
        if short_side <= 0:
            continue
        aspect = long_side / short_side
        if aspect < 1.18 or aspect > 3.2:
            continue

        rectangularity = min(1.0, contour_area / max(rect_area, 1.0))
        center = np.array(rect[0], dtype=np.float32)
        center_distance = float(np.linalg.norm(center - image_center))
        center_score = max(0.0, 1.0 - center_distance / max(math.hypot(width, height) * 0.5, 1.0))

        min_x, min_y = ordered.min(axis=0)
        max_x, max_y = ordered.max(axis=0)
        touches = sum((
            min_x <= border_margin,
            min_y <= border_margin,
            max_x >= width - border_margin,
            max_y >= height - border_margin,
        ))
        # A rectangle coinciding with the photo itself is usually the image boundary,
        # not a detected television. Keep partially cropped TVs, but reject this trap.
        if touches >= 3 and area_ratio > 0.86:
            continue

        aspect_score = math.exp(-abs(math.log(aspect / (16.0 / 9.0))) * 1.35)
        area_score = min(1.0, area_ratio / 0.55)
        border_score = max(0.0, 1.0 - touches * 0.18)
        score = (
            area_score * 0.34
            + aspect_score * 0.27
            + rectangularity * 0.20
            + center_score * 0.11
            + border_score * 0.08
        )
        candidates.append({
            "score": score,
            "box": ordered / scale,
            "areaRatio": area_ratio,
            "aspectRatio": aspect,
            "rectangularity": rectangularity,
            "touches": touches,
        })

    if not candidates:
        return None

    candidates.sort(key=lambda item: item["score"], reverse=True)
    best = candidates[0]
    runner_up = candidates[1]["score"] if len(candidates) > 1 else 0.0
    separation = max(0.0, best["score"] - runner_up)
    confidence = min(0.98, max(0.0, best["score"] * 0.82 + min(separation, 0.18)))

    ordered = best["box"]
    tl, tr, br, bl = ordered
    vector_a = ((tr - tl) + (br - bl)) / 2.0
    vector_b = ((bl - tl) + (br - tr)) / 2.0
    long_vector = vector_a if np.linalg.norm(vector_a) >= np.linalg.norm(vector_b) else vector_b
    long_axis_vertical = abs(float(long_vector[1])) > abs(float(long_vector[0]))

    return {
        **best,
        "confidence": confidence,
        "candidateCount": len(candidates),
        "longAxisVertical": long_axis_vertical,
    }


def _warp_tv_roi(bgr: np.ndarray, ordered: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = ordered.astype(np.float32)
    width = max(float(np.linalg.norm(tr - tl)), float(np.linalg.norm(br - bl)))
    height = max(float(np.linalg.norm(bl - tl)), float(np.linalg.norm(br - tr)))
    out_w = max(1, int(round(width)))
    out_h = max(1, int(round(height)))
    resize_scale = min(1.0, 1600.0 / max(out_w, out_h))
    out_w = max(1, int(round(out_w * resize_scale)))
    out_h = max(1, int(round(out_h * resize_scale)))
    destination = np.array([
        [0, 0],
        [out_w - 1, 0],
        [out_w - 1, out_h - 1],
        [0, out_h - 1],
    ], dtype=np.float32)
    transform = cv2.getPerspectiveTransform(ordered.astype(np.float32), destination)
    roi = cv2.warpPerspective(bgr, transform, (out_w, out_h))
    if roi.shape[0] > roi.shape[1]:
        roi = cv2.rotate(roi, cv2.ROTATE_90_CLOCKWISE)
    return roi


def _get_ocr_reader():
    global _OCR_READER
    if _OCR_READER is None:
        from paddleocr import PaddleOCR

        _OCR_READER = PaddleOCR(
            lang=os.getenv("ORIENTATION_OCR_LANG", "ch"),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            device="cpu",
        )
    return _OCR_READER


def _extract_ocr_payload(result: Any) -> dict[str, Any]:
    raw_json = getattr(result, "json", None)
    if callable(raw_json):
        raw_json = raw_json()
    if not isinstance(raw_json, dict):
        return {}
    payload = raw_json.get("res", raw_json)
    return payload if isinstance(payload, dict) else {}


def _ocr_quality(bgr: np.ndarray) -> dict[str, Any]:
    reader = _get_ocr_reader()
    valid: list[dict[str, Any]] = []
    for result in reader.predict(bgr):
        payload = _extract_ocr_payload(result)
        texts = payload.get("rec_texts", []) or []
        scores = payload.get("rec_scores", []) or []
        for text, score in zip(texts, scores):
            cleaned = str(text or "").strip()
            numeric_score = float(score)
            visible_length = len(_TEXT_RE.findall(cleaned))
            if visible_length >= 2 and numeric_score >= 0.32:
                valid.append({
                    "text": cleaned[:32],
                    "score": round(numeric_score, 3),
                    "length": visible_length,
                })

    valid.sort(key=lambda item: item["score"], reverse=True)
    top = valid[:8]
    if not top:
        return {"quality": 0.0, "count": 0, "texts": []}
    weights = [min(item["length"], 12) for item in top]
    weighted = sum(item["score"] * weight for item, weight in zip(top, weights)) / max(sum(weights), 1)
    coverage = min(1.0, 0.55 + len(top) * 0.15)
    return {
        "quality": round(weighted * coverage, 4),
        "count": len(top),
        "texts": [{"text": item["text"], "score": item["score"]} for item in top[:5]],
    }


def _compare_ocr_orientation(landscape_roi: np.ndarray) -> dict[str, Any]:
    if os.getenv("ORIENTATION_OCR_ENABLED", "true").strip().lower() not in {"1", "true", "yes", "on"}:
        return {"decision": "uncertain", "confidence": 0.0, "error": "OCR disabled"}
    try:
        with _OCR_LOCK:
            candidate_a = _ocr_quality(landscape_roi)
            candidate_b = _ocr_quality(cv2.rotate(landscape_roi, cv2.ROTATE_180))
    except Exception as exc:
        return {
            "decision": "uncertain",
            "confidence": 0.0,
            "error": f"OCR unavailable: {str(exc)[:240]}",
        }

    qa = float(candidate_a["quality"])
    qb = float(candidate_b["quality"])
    winner = "normal" if qa >= qb else "rotated180"
    best = max(qa, qb)
    margin = abs(qa - qb)
    confidence = min(0.98, best * 0.72 + min(0.28, margin * 1.8))
    decisive = best >= 0.50 and (
        margin >= 0.10
        or (margin >= 0.065 and min(candidate_a["count"], candidate_b["count"]) == 0)
    )
    if not decisive:
        winner = "uncertain"

    return {
        "decision": winner,
        "confidence": round(confidence, 3),
        "margin": round(margin, 4),
        "candidateA": candidate_a,
        "candidateB": candidate_b,
    }


def detect_tv_orientation(image: Image.Image, use_ocr: bool = True) -> dict[str, Any]:
    rgb = np.asarray(image.convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    detected = _detect_tv_rectangle(bgr)
    if detected is None:
        return {
            "status": "confirmation_required",
            "method": "geometry",
            "tvDetected": False,
            "baseRotation": 0,
            "finalRotation": 0,
            "geometryConfidence": 0.0,
            "requiresConfirmation": True,
            "reason": "未可靠检测到电视矩形边框，未使用整图宽高猜测方向",
            "ocr": {"decision": "not_run", "confidence": 0.0},
        }

    base_rotation = 90 if detected["longAxisVertical"] else 0
    ocr = {"decision": "not_run", "confidence": 0.0}
    if use_ocr:
        roi = _warp_tv_roi(bgr, detected["box"])
        ocr = _compare_ocr_orientation(roi)

    flip = 180 if ocr.get("decision") == "rotated180" else 0
    final_rotation = (base_rotation + flip) % 360
    geometry_confidence = round(float(detected["confidence"]), 3)
    ocr_decisive = ocr.get("decision") in {"normal", "rotated180"} and float(ocr.get("confidence", 0)) >= OCR_AUTO_THRESHOLD
    requires_confirmation = geometry_confidence < GEOMETRY_AUTO_THRESHOLD or not ocr_decisive

    box = detected["box"]
    return {
        "status": "confirmation_required" if requires_confirmation else "auto_decided",
        "method": "geometry+ocr" if use_ocr else "geometry",
        "tvDetected": True,
        "baseRotation": base_rotation,
        "finalRotation": final_rotation,
        "geometryConfidence": geometry_confidence,
        "requiresConfirmation": requires_confirmation,
        "reason": (
            "电视边框或文字方向证据不足"
            if requires_confirmation
            else "电视长轴与文字方向证据一致"
        ),
        "tvRegion": {
            "points": [[round(float(x), 1), round(float(y), 1)] for x, y in box],
            "areaRatio": round(float(detected["areaRatio"]), 3),
            "aspectRatio": round(float(detected["aspectRatio"]), 3),
            "rectangularity": round(float(detected["rectangularity"]), 3),
            "candidateCount": int(detected["candidateCount"]),
            "longAxis": "vertical" if detected["longAxisVertical"] else "horizontal",
        },
        "ocr": ocr,
    }


__all__ = ["detect_tv_orientation"]
