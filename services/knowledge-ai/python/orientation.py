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
import base64
import time
from typing import Any

import cv2
import numpy as np
from PIL import Image


os.environ.setdefault("PADDLE_PDX_CACHE_HOME", "/models/paddlex")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

MAX_DETECTION_DIMENSION = 1280
GEOMETRY_AUTO_THRESHOLD = 0.62
OCR_AUTO_THRESHOLD = 0.80

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


def _debug_edge_image(edges: np.ndarray) -> str:
    """Encode only Canny edge pixels as opaque green; the background is transparent."""
    transparent_green = np.zeros((edges.shape[0], edges.shape[1], 4), dtype=np.uint8)
    transparent_green[:, :, 0] = 94   # B in #22c55e
    transparent_green[:, :, 1] = 197  # G
    transparent_green[:, :, 2] = 34   # R
    transparent_green[:, :, 3] = edges
    ok, encoded = cv2.imencode(".png", transparent_green)
    return base64.b64encode(encoded.tobytes()).decode("ascii") if ok else ""


def _detect_tv_rectangle(bgr: np.ndarray, include_debug: bool = False) -> dict[str, Any] | None:
    detection_started = time.perf_counter()
    source_h, source_w = bgr.shape[:2]
    scale = min(1.0, MAX_DETECTION_DIMENSION / max(source_w, source_h))
    if scale < 1.0:
        work = cv2.resize(bgr, (round(source_w * scale), round(source_h * scale)), interpolation=cv2.INTER_AREA)
    else:
        work = bgr

    height, width = work.shape[:2]
    image_area = float(width * height)
    canny_started = time.perf_counter()
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median = float(np.median(blurred))
    low = max(20, int(median * 0.55))
    high = min(220, max(low + 30, int(median * 1.45)))
    edges = cv2.Canny(blurred, low, high)
    canny_ms = (time.perf_counter() - canny_started) * 1000.0
    candidates: list[dict[str, Any]] = []
    rejected: dict[str, int] = {}

    def reject(reason: str) -> None:
        if include_debug:
            rejected[reason] = rejected.get(reason, 0) + 1
    border_margin = max(4.0, min(width, height) * 0.012)
    image_center = np.array([width / 2.0, height / 2.0], dtype=np.float32)
    # Expand raw Canny pixels slightly before sampling. This measures whether the
    # proposed rectangle is backed by real edges, rather than only by morphology.
    edge_band = cv2.dilate(edges, np.ones((5, 5), dtype=np.uint8), iterations=1)

    def edge_support(ordered: np.ndarray) -> tuple[float, float]:
        side_scores: list[float] = []
        for start, end in zip(ordered, np.roll(ordered, -1, axis=0)):
            samples = max(24, int(np.linalg.norm(end - start) / 8))
            xs = np.clip(np.linspace(start[0], end[0], samples).round().astype(int), 0, width - 1)
            ys = np.clip(np.linspace(start[1], end[1], samples).round().astype(int), 0, height - 1)
            side_scores.append(float(np.mean(edge_band[ys, xs] > 0)))
        return float(np.mean(side_scores)), float(min(side_scores))

    def angle_distance(first: float, second: float) -> float:
        difference = abs(first - second) % 180.0
        return min(difference, 180.0 - difference)

    def detect_partial_candidate() -> dict[str, Any] | None:
        """Infer a partial TV from two near-orthogonal Hough line families."""
        minimum_length = max(45, int(min(width, height) * 0.14))
        raw_lines = cv2.HoughLinesP(
            edges,
            1,
            np.pi / 180.0,
            threshold=max(35, int(min(width, height) * 0.045)),
            minLineLength=minimum_length,
            maxLineGap=max(18, int(min(width, height) * 0.06)),
        )
        if raw_lines is None:
            return None

        segments = []
        for raw in raw_lines[:, 0, :]:
            x1, y1, x2, y2 = (float(value) for value in raw)
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy)
            if length < minimum_length:
                continue
            segments.append({
                "points": np.array([[x1, y1], [x2, y2]], dtype=np.float32),
                "length": length,
                "angle": math.degrees(math.atan2(dy, dx)) % 180.0,
            })
        segments.sort(key=lambda item: item["length"], reverse=True)
        segments = segments[:36]
        if len(segments) < 3:
            return None

        best_group = None
        for seed in segments[:12]:
            primary = [item for item in segments if angle_distance(item["angle"], seed["angle"]) <= 12.0]
            perpendicular_angle = (seed["angle"] + 90.0) % 180.0
            secondary = [item for item in segments if angle_distance(item["angle"], perpendicular_angle) <= 16.0]
            if not primary or not secondary or len(primary) + len(secondary) < 3:
                continue
            support_length = sum(item["length"] for item in primary + secondary)
            group = (support_length, primary, secondary)
            if best_group is None or group[0] > best_group[0]:
                best_group = group
        if best_group is None:
            return None

        _, primary, secondary = best_group
        # Two parallel long edges plus one side, or the inverse, are considerably
        # safer than a single L-shaped environmental corner.
        if max(len(primary), len(secondary)) < 2:
            return None
        selected = primary + secondary
        endpoints = np.concatenate([item["points"] for item in selected], axis=0)
        rect = cv2.minAreaRect(endpoints)
        (_, _), (rect_w, rect_h), _ = rect
        if min(rect_w, rect_h) < 30:
            return None
        inferred = _order_points(cv2.boxPoints(rect).astype(np.float32))
        inferred_area = float(rect_w * rect_h)
        area_ratio = inferred_area / image_area
        aspect = max(rect_w, rect_h) / max(min(rect_w, rect_h), 1.0)
        if not (0.05 <= area_ratio <= 0.90 and 1.10 <= aspect <= 4.2):
            return None

        min_x, min_y = inferred.min(axis=0)
        max_x, max_y = inferred.max(axis=0)
        touches = sum((
            min_x <= border_margin, min_y <= border_margin,
            max_x >= width - border_margin, max_y >= height - border_margin,
        ))
        if touches >= 3 and area_ratio > 0.82:
            return None

        perimeter = max(2.0 * (rect_w + rect_h), 1.0)
        line_coverage = min(1.0, sum(item["length"] for item in selected) / (perimeter * 1.8))
        family_balance = min(len(primary), len(secondary)) / max(len(primary), len(secondary))
        evidence_score = min(1.0, len(selected) / 7.0)
        score = 0.58 + line_coverage * 0.13 + family_balance * 0.06 + evidence_score * 0.07
        visible_lines = [
            [[round(float(x / scale), 1), round(float(y / scale), 1)] for x, y in item["points"]]
            for item in selected[:16]
        ]
        return {
            "score": min(0.84, score),
            "box": inferred / scale,
            "areaRatio": area_ratio,
            "aspectRatio": aspect,
            "rectangularity": 0.5,
            "touches": touches,
            "edgeSupport": line_coverage,
            "weakestSideSupport": 0.0,
            "closing": "Hough 局部边线推断",
            "detectionMethod": "partial-lines",
            "perspectiveDistortion": 0.0,
            "partial": True,
            "visibleLines": visible_lines,
        }

    def collect_candidates(contours: list[np.ndarray], closing: str) -> None:
        for contour in contours:

            contour_area = float(cv2.contourArea(contour))
            if contour_area < image_area * 0.06:
                reject("轮廓面积过小")
                continue

            # A perspective TV is a convex quadrilateral, not a rotated rectangle.
            # Approximate its hull at several tolerances and keep the first stable
            # four-corner result. Near-perfect rectangles stay on the fast path.
            hull = cv2.convexHull(contour)
            perimeter = float(cv2.arcLength(hull, True))
            quad = None
            for epsilon_ratio in (0.012, 0.02, 0.03, 0.045):
                approximation = cv2.approxPolyDP(hull, perimeter * epsilon_ratio, True)
                if len(approximation) == 4 and cv2.isContourConvex(approximation):
                    quad = _order_points(approximation.reshape(4, 2).astype(np.float32))
                    break

            if quad is not None:
                tl, tr, br, bl = quad
                lengths = [
                    float(np.linalg.norm(tr - tl)), float(np.linalg.norm(br - bl)),
                    float(np.linalg.norm(bl - tl)), float(np.linalg.norm(br - tr)),
                ]
                top, bottom, left, right = lengths
                mean_horizontal = (top + bottom) / 2.0
                mean_vertical = (left + right) / 2.0
                short_side = min(mean_horizontal, mean_vertical)
                quad_area = abs(float(cv2.contourArea(quad)))
                quad_area_ratio = quad_area / image_area
                opposite_similarity = min(
                    min(top, bottom) / max(top, bottom, 1.0),
                    min(left, right) / max(left, right, 1.0),
                )
                corner_cosines = []
                for index, point in enumerate(quad):
                    previous = quad[(index - 1) % 4] - point
                    following = quad[(index + 1) % 4] - point
                    denominator = max(float(np.linalg.norm(previous) * np.linalg.norm(following)), 1.0)
                    corner_cosines.append(abs(float(np.dot(previous, following))) / denominator)
                perspective_distortion = max(corner_cosines)
                is_perspective = opposite_similarity < 0.92 or perspective_distortion > 0.10
                quad_aspect = max(mean_horizontal, mean_vertical) / max(short_side, 1.0)

                if (
                    is_perspective
                    and short_side >= 30
                    and 0.08 <= quad_area_ratio <= 1.03
                    and 1.12 <= quad_aspect <= 3.8
                    and opposite_similarity >= 0.32
                ):
                    min_x, min_y = quad.min(axis=0)
                    max_x, max_y = quad.max(axis=0)
                    touches = sum((
                        min_x <= border_margin, min_y <= border_margin,
                        max_x >= width - border_margin, max_y >= height - border_margin,
                    ))
                    quad_support, weakest_quad_side = edge_support(quad)
                    if not (touches >= 3 and quad_area_ratio > 0.86) and quad_support >= 0.13 and weakest_quad_side >= 0.025:
                        center = np.mean(quad, axis=0)
                        center_distance = float(np.linalg.norm(center - image_center))
                        center_score = max(0.0, 1.0 - center_distance / max(math.hypot(width, height) * 0.5, 1.0))
                        fill = min(1.0, contour_area / max(quad_area, 1.0))
                        aspect_score = math.exp(-abs(math.log(quad_aspect / (16.0 / 9.0))) * 1.20)
                        area_score = min(1.0, quad_area_ratio / 0.55)
                        border_score = max(0.0, 1.0 - touches * 0.18)
                        perspective_score = opposite_similarity * 0.55 + (1.0 - min(1.0, perspective_distortion)) * 0.45
                        score = (
                            area_score * 0.29 + aspect_score * 0.23 + fill * 0.15
                            + center_score * 0.09 + border_score * 0.07
                            + quad_support * 0.12 + perspective_score * 0.05
                        )
                        candidates.append({
                            "score": score,
                            "box": quad / scale,
                            "areaRatio": quad_area_ratio,
                            "aspectRatio": quad_aspect,
                            "rectangularity": fill,
                            "touches": touches,
                            "edgeSupport": quad_support,
                            "weakestSideSupport": weakest_quad_side,
                            "closing": closing,
                            "detectionMethod": "perspective-quadrilateral",
                            "perspectiveDistortion": perspective_distortion,
                        })

            rect = cv2.minAreaRect(contour)
            (_, _), (rect_w, rect_h), _ = rect
            if rect_w < 30 or rect_h < 30:
                reject("候选边长过短")
                continue
            rect_area = float(rect_w * rect_h)
            area_ratio = rect_area / image_area
            if area_ratio < 0.08 or area_ratio > 1.03:
                reject("候选矩形面积不符合范围")
                continue

            box = cv2.boxPoints(rect).astype(np.float32)
            ordered = _order_points(box)
            side_a, side_b = _edge_lengths(ordered)
            long_side = max(side_a, side_b)
            short_side = min(side_a, side_b)
            if short_side <= 0:
                reject("候选矩形无有效短边")
                continue
            aspect = long_side / short_side
            if aspect < 1.18 or aspect > 3.2:
                reject("长宽比不像电视")
                continue

            rectangularity = min(1.0, contour_area / max(rect_area, 1.0))
            center = np.array(rect[0], dtype=np.float32)
            center_distance = float(np.linalg.norm(center - image_center))
            center_score = max(0.0, 1.0 - center_distance / max(math.hypot(width, height) * 0.5, 1.0))

            min_x, min_y = ordered.min(axis=0)
            max_x, max_y = ordered.max(axis=0)
            touches = sum((
                min_x <= border_margin, min_y <= border_margin,
                max_x >= width - border_margin, max_y >= height - border_margin,
            ))
            if touches >= 3 and area_ratio > 0.86:
                reject("疑似整张照片边界")
                continue

            support, weakest_side_support = edge_support(ordered)
            if support < 0.13 or weakest_side_support < 0.025:
                reject("候选框缺少原始边缘支撑")
                continue

            aspect_score = math.exp(-abs(math.log(aspect / (16.0 / 9.0))) * 1.35)
            area_score = min(1.0, area_ratio / 0.55)
            border_score = max(0.0, 1.0 - touches * 0.18)
            score = (
                area_score * 0.31 + aspect_score * 0.25 + rectangularity * 0.18
                + center_score * 0.10 + border_score * 0.07 + support * 0.09
            )
            candidates.append({
                "score": score,
                "box": ordered / scale,
                "areaRatio": area_ratio,
                "aspectRatio": aspect,
                "rectangularity": rectangularity,
                "touches": touches,
                "edgeSupport": support,
                "weakestSideSupport": weakest_side_support,
                "closing": closing,
                "detectionMethod": "rotated-rectangle",
                "perspectiveDistortion": 0.0,
            })

    closing_started = time.perf_counter()
    standard_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    standard_joined = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, standard_kernel, iterations=2)
    standard_contours, _ = cv2.findContours(standard_joined, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    closing_ms = (time.perf_counter() - closing_started) * 1000.0
    geometry_started = time.perf_counter()
    collect_candidates(standard_contours, "标准 Closing 7×7 ×2")

    # Strong closing is a fallback only: it helps a genuinely broken bezel but
    # is never allowed to compete with a normally detected frame.
    adaptive_contours: list[np.ndarray] = []
    adaptive_used = False
    if not candidates:
        adaptive_used = True
        adaptive_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21))
        adaptive_closing_started = time.perf_counter()
        adaptive_joined = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, adaptive_kernel, iterations=2)
        adaptive_contours, _ = cv2.findContours(adaptive_joined, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        closing_ms += (time.perf_counter() - adaptive_closing_started) * 1000.0
        collect_candidates(adaptive_contours, "自适应 Closing 21×21 ×2")

    if not candidates:
        partial_candidate = detect_partial_candidate()
        if partial_candidate is not None:
            candidates.append(partial_candidate)
    geometry_ms = (time.perf_counter() - geometry_started) * 1000.0

    debug = None
    if include_debug:
        debug = {
            "edgeImage": _debug_edge_image(edges),
            "edgeWidth": int(width),
            "edgeHeight": int(height),
            "scale": round(float(scale), 6),
            "contourCount": len(standard_contours) + len(adaptive_contours),
            "closing": "自适应 Closing 21×21 ×2" if adaptive_used else "标准 Closing 7×7 ×2",
            "rejected": rejected,
            "timings": {
                "cannyMs": round(canny_ms, 1),
                "closingMs": round(closing_ms, 1),
                "geometryMs": round(geometry_ms, 1),
                "totalMs": round((time.perf_counter() - detection_started) * 1000.0, 1),
            },
            # Limit the payload and visual clutter while preserving the strongest alternatives.
            "candidates": [],
        }

    if not candidates:
        if debug is not None:
            return {"debug": debug}
        return None

    candidates.sort(key=lambda item: item["score"], reverse=True)
    best = candidates[0]
    if debug is not None:
        debug["candidates"] = [{
            "points": [[round(float(x), 1), round(float(y), 1)] for x, y in candidate["box"]],
            "score": round(float(candidate["score"]), 3),
            "areaRatio": round(float(candidate["areaRatio"]), 3),
            "aspectRatio": round(float(candidate["aspectRatio"]), 3),
            "edgeSupport": round(float(candidate["edgeSupport"]), 3),
            "closing": candidate["closing"],
            "detectionMethod": candidate["detectionMethod"],
            "perspectiveDistortion": round(float(candidate["perspectiveDistortion"]), 3),
        } for candidate in candidates[:12]]
        if best.get("partial"):
            debug["closing"] = "Hough 局部边线推断"
            debug["partialLines"] = best.get("visibleLines", [])
    runner_up = candidates[1]["score"] if len(candidates) > 1 else 0.0
    separation = max(0.0, best["score"] - runner_up)
    confidence = min(0.98, max(0.0, best["score"] * 0.82 + min(separation, 0.18)))
    if best.get("partial"):
        # Missing corners are inferred, so candidate separation must not inflate
        # confidence. Strong partial evidence may suggest orientation, but remains capped.
        confidence = min(0.72, max(0.0, best["score"] * 0.82))

    ordered = best["box"]
    tl, tr, br, bl = ordered
    vector_a = ((tr - tl) + (br - bl)) / 2.0
    vector_b = ((bl - tl) + (br - tr)) / 2.0
    long_vector = vector_a if np.linalg.norm(vector_a) >= np.linalg.norm(vector_b) else vector_b
    long_axis_vertical = abs(float(long_vector[1])) > abs(float(long_vector[0]))

    result = {
        **best,
        "confidence": confidence,
        "candidateCount": len(candidates),
        "longAxisVertical": long_axis_vertical,
    }
    if debug is not None:
        debug["selectedIndex"] = 0
        result["debug"] = debug
    return result


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


def compare_tv_orientation_ocr(image: Image.Image, points: list[list[float]]) -> dict[str, Any]:
    """Run only the 0/180 OCR comparison for a previously detected TV quadrilateral."""
    if len(points) != 4 or any(len(point) != 2 for point in points):
        raise ValueError("电视区域必须包含四个二维角点")
    rgb = np.asarray(image.convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    ordered = _order_points(np.asarray(points, dtype=np.float32))
    roi = _warp_tv_roi(bgr, ordered)
    started = time.perf_counter()
    result = _compare_ocr_orientation(roi)
    result["durationMs"] = round((time.perf_counter() - started) * 1000.0, 1)
    return result


def detect_tv_orientation(image: Image.Image, use_ocr: bool = False, include_debug: bool = False) -> dict[str, Any]:
    rgb = np.asarray(image.convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    detected = _detect_tv_rectangle(bgr, include_debug=include_debug)
    if detected is None or "box" not in detected:
        result = {
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
        if include_debug and detected and detected.get("debug"):
            result["debug"] = detected["debug"]
        return result

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
    result = {
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
            "detectionMethod": detected.get("detectionMethod", "rotated-rectangle"),
            "perspectiveDistortion": round(float(detected.get("perspectiveDistortion", 0.0)), 3),
            "partial": bool(detected.get("partial", False)),
            "longAxis": "vertical" if detected["longAxisVertical"] else "horizontal",
        },
        "ocr": ocr,
    }
    if include_debug and detected.get("debug"):
        result["debug"] = detected["debug"]
    return result


__all__ = ["detect_tv_orientation", "compare_tv_orientation_ocr"]
