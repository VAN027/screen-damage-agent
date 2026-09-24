#!/usr/bin/env python3
"""
TV 屏幕矩形轮廓检测 — 判断照片是否需要旋转

基于 OpenCV 的轮廓检测 + minAreaRect，找到 TV 屏幕的矩形边框，
判断照片是否需要旋转 90°（竖拍变横拍）。

180°（倒立）判断：将电视摆正后，裁剪边框条带（底部/左侧/右侧），
用 PaddleOCR 的文本行方向分类模型（TextLineOrientationClassification）
识别条带内文字/Logo 是否倒置。

用法:
  python detect-tv-orientation.py <image_path>
  python detect-tv-orientation.py --json <image_path>
  python detect-tv-orientation.py --annotate <image_path>     # 输出 base64 标注图
  python detect-tv-orientation.py --annotate --params '{"canny_low":30,...}' <image_path>
  cat img.jpg | python detect-tv-orientation.py --json -        # stdin 模式

输出 JSON:
  {"angle": 0|90|180|270, "confidence": 0-1, "method": "contour",
   "annotated_base64": "..."}  # 仅 --annotate 时包含
"""

import os
import sys
import json
import base64
import cv2
import numpy as np


# PaddleX 模型缓存目录默认在 ~/.paddlex，沙箱下不可写，改到项目内
_PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('PADDLE_PDX_CACHE_HOME', os.path.join(_PROJECT_DIR, '.paddlex'))
# 模型源使用国内 BOS，避免 HuggingFace 访问超时
os.environ.setdefault('PADDLE_PDX_MODEL_SOURCE', 'BOS')
# PP-OCRv6 在 MKLDNN(onednn) 下会触发 PaddlePaddle 3.3 的 PIR 属性转换 bug，禁用之
os.environ.setdefault('PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT', '0')


DEFAULT_PARAMS = {
    # 边缘检测
    "canny_low": 30,
    "canny_high": 100,
    "blur_kernel": 5,
    "dilate_kernel": 7,
    "dilate_iter": 1,
    # TV 轮廓筛选
    "area_min_ratio": 0.12,
    "fill_min": 0.3,
    "rot90_ratio": 1.1,
    # OCR 方向判断
    "ocr_enabled": True,
    "ocr_strip_ratio": 0.15,   # 边框条带裁剪比例
    "ocr_min_score": 0.8,      # OCR 最低置信度
}

# 懒加载 OCR 模型（进程级单例，避免重复加载）
_OCR_MODEL = None


def _get_ocr_model():
    """懒加载 PaddleOCR 文本行方向分类模型"""
    global _OCR_MODEL
    if _OCR_MODEL is None:
        from paddleocr import TextLineOrientationClassification
        _OCR_MODEL = TextLineOrientationClassification(
            model_name='PP-LCNet_x0_25_textline_ori',
            device='cpu',
        )
    return _OCR_MODEL


# 懒加载文本识别模型（进程级单例）
_OCR_READER = None


def _get_ocr_reader():
    """懒加载 PaddleOCR 文本识别 pipeline（检测 + 识别）"""
    global _OCR_READER
    if _OCR_READER is None:
        from paddleocr import PaddleOCR
        _OCR_READER = PaddleOCR(
            lang='ch',
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    return _OCR_READER


def _order_points(pts):
    """将 4 个顶点排序为 [左上, 右上, 右下, 左下]"""
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # 左上 (sum 最小)
    rect[2] = pts[np.argmax(s)]  # 右下 (sum 最大)
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # 右上
    rect[3] = pts[np.argmax(diff)]  # 左下
    return rect


def _upright_tv(img, best_rect, need_rot90):
    """
    用透视变换将电视摆正为「横放、边框水平」的图像。

    返回摆正后的电视 ROI（宽 >= 高）。若 need_rot90 为 True，
    目标矩形宽高互换，使竖放的电视转成横放。
    """
    box = cv2.boxPoints(best_rect).astype("float32")
    box = _order_points(box)
    (tl, tr, br, bl) = box

    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    height_left = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)

    max_w = int(round(max(width_top, width_bottom)))
    max_h = int(round(max(height_left, height_right)))

    # 目标矩形（保证横放）
    if need_rot90:
        dst_w, dst_h = max_h, max_w
    else:
        dst_w, dst_h = max_w, max_h

    # 限制最大尺寸，避免透视变换内存爆炸
    scale = 1.0
    if max(dst_w, dst_h) > 2000:
        scale = 2000.0 / max(dst_w, dst_h)
        dst_w = max(1, int(dst_w * scale))
        dst_h = max(1, int(dst_h * scale))

    dst = np.array([
        [0, 0],
        [dst_w - 1, 0],
        [dst_w - 1, dst_h - 1],
        [0, dst_h - 1],
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(box, dst)
    warped = cv2.warpPerspective(img, M, (dst_w, dst_h))
    return warped


def _extract_bezel_strips(upright_img, strip_ratio=0.15):
    """
    从摆正后的电视图像中裁剪边框条带（底部/左侧/右侧）。
    品牌 Logo 通常位于底部居中或左右侧边。
    返回 [(name, strip_img), ...]
    """
    h, w = upright_img.shape[:2]
    strips = []

    # 底部条带（Logo 最常见位置）
    bh = max(int(h * strip_ratio), 16)
    if h > bh:
        strips.append(("bottom", upright_img[h - bh:, :]))

    # 左侧条带
    lw = max(int(w * strip_ratio), 16)
    if w > lw:
        strips.append(("left", upright_img[:, :lw]))

    # 右侧条带
    rw = max(int(w * strip_ratio), 16)
    if w > rw:
        strips.append(("right", upright_img[:, w - rw:]))

    return strips


def _ocr_detect_flip(strip_images, min_score=0.8):
    """
    对多个边框条带做文字方向分类，返回倒置判断。

    返回: {"flip": bool, "score": float, "label": str, "strip": str, "error": str|None}
    """
    try:
        model = _get_ocr_model()
    except Exception as e:
        return {"flip": False, "score": 0.0, "label": None, "strip": None, "error": str(e)}

    best = {"flip": False, "score": 0.0, "label": None, "strip": None}

    for name, strip in strip_images:
        if strip is None or strip.size == 0 or strip.shape[0] < 8 or strip.shape[1] < 8:
            continue
        try:
            out = model.predict(strip, batch_size=1)
            for r in out:
                data = r.json.get('res', {}) if isinstance(r.json, dict) else {}
                class_ids = data.get('class_ids', [])
                scores = data.get('scores', [])
                label_names = data.get('label_names', [])

                if len(class_ids) == 0:
                    continue

                cid = int(np.asarray(class_ids).reshape(-1)[0])
                score = float(np.asarray(scores).reshape(-1)[0]) if len(scores) > 0 else 0.0
                label = label_names[0] if label_names else ('180_degree' if cid == 1 else '0_degree')
                is_flip = (cid == 1)

                if score > best['score']:
                    best = {"flip": is_flip, "score": score, "label": label, "strip": name}
        except Exception:
            continue

    # 置信度低于阈值时不翻转
    if best['score'] < min_score:
        best['flip'] = False

    return best


def _ocr_read_texts(img):
    """
    对图像做文本识别，返回识别出的文字列表。

    返回: (texts, error)
      texts: [{"text": str, "score": float}, ...]
      error: str 或 None
    """
    try:
        reader = _get_ocr_reader()
    except Exception as e:
        return [], str(e)

    if img is None or img.size == 0:
        return [], "empty image"

    texts = []
    try:
        out = reader.predict(img)
        for r in out:
            data = r.json.get('res', {}) if isinstance(r.json, dict) else {}
            rec_texts = data.get('rec_texts', [])
            rec_scores = data.get('rec_scores', [])
            for t, s in zip(rec_texts, rec_scores):
                t = (t or '').strip()
                if t:
                    texts.append({"text": t, "score": round(float(s), 3)})
    except Exception as e:
        return [], str(e)

    return texts, None


def detect_tv_orientation(img_buf_or_path, params=None, annotate=False):
    """
    检测 TV 屏幕方向，返回需要旋转的角度。

    参数:
      img_buf_or_path: 图片路径(str) 或 二进制数据(bytes)
      params: 可选参数字典，覆盖 DEFAULT_PARAMS
      annotate: 是否生成可视化标注图

    返回: {"angle": int, "confidence": float, "method": str, ...}
    """

    p = {**DEFAULT_PARAMS, **(params or {})}

    # --- 读取图像 ---
    if isinstance(img_buf_or_path, bytes):
        nparr = np.frombuffer(img_buf_or_path, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    elif img_buf_or_path == '-':
        buf = sys.stdin.buffer.read()
        nparr = np.frombuffer(buf, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(img_buf_or_path)

    if img is None:
        return {"angle": 0, "confidence": 0, "method": "contour", "error": "无法读取图像"}

    h_img, w_img = img.shape[:2]
    img_area = h_img * w_img
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # --- Step 1: 边缘检测 + 轮廓提取 ---
    ksize = p["blur_kernel"]
    if ksize % 2 == 0:
        ksize += 1
    blurred = cv2.GaussianBlur(gray, (ksize, ksize), 0)
    edges = cv2.Canny(blurred, p["canny_low"], p["canny_high"])

    dk = p["dilate_kernel"]
    if dk % 2 == 0:
        dk += 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (dk, dk))
    dilated = cv2.dilate(edges, kernel, iterations=p["dilate_iter"])

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # --- Step 2: 筛选最可能是 TV 屏幕的矩形轮廓 ---
    best_rect = None
    best_score = 0
    best_contour = None
    all_contours_info = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < img_area * p["area_min_ratio"]:
            continue

        rect = cv2.minAreaRect(cnt)
        (cx, cy), (rw, rh), angle = rect

        if rw < 10 or rh < 10:
            continue

        rect_area = rw * rh
        fill_ratio = area / rect_area if rect_area > 0 else 0

        perimeter = cv2.arcLength(cnt, True)
        rect_perimeter = 2 * (rw + rh)
        perimeter_ratio = perimeter / rect_perimeter if rect_perimeter > 0 else 0

        is_hollow_rect = fill_ratio < 0.7 and perimeter_ratio > 1.3

        if fill_ratio < p["fill_min"] and not is_hollow_rect:
            all_contours_info.append({
                "area": round(area), "fill": round(fill_ratio, 3),
                "perim_ratio": round(perimeter_ratio, 3), "rejected": "low_fill"
            })
            continue

        score = area
        all_contours_info.append({
            "area": round(area), "fill": round(fill_ratio, 3),
            "perim_ratio": round(perimeter_ratio, 3), "accepted": score > best_score
        })

        if score > best_score:
            best_score = score
            best_rect = rect
            best_contour = cnt

    # --- Step 3: 判断是否需要旋转 90° ---
    need_rot90 = False

    if best_rect is not None:
        (cx, cy), (rw, rh), angle = best_rect
        need_rot90 = rh > rw * p["rot90_ratio"]
        tv_region = {
            "cx": round(cx), "cy": round(cy),
            "w": round(rw), "h": round(rh),
            "area_ratio": round(best_score / img_area, 3),
            "contours_found": len(contours),
            "contours_passed": len([c for c in all_contours_info if "accepted" in c]),
        }
    else:
        need_rot90 = h_img > w_img * p["rot90_ratio"]
        tv_region = {"fallback": "aspect_ratio", "contours_found": len(contours)}

    # --- Step 4: OCR 判断是否需要翻转 180° ---
    need_flip180 = False
    ocr_result = {"flip": False, "score": 0.0, "label": None, "strip": None, "error": None}

    if best_rect is not None and p.get("ocr_enabled", True):
        # 摆正电视（透视变换），得到横放状态的电视图像
        upright_img = _upright_tv(img, best_rect, need_rot90)
        # 裁剪边框条带
        strips = _extract_bezel_strips(upright_img, p.get("ocr_strip_ratio", 0.15))
        # OCR 方向判断
        ocr_result = _ocr_detect_flip(strips, p.get("ocr_min_score", 0.8))
        need_flip180 = ocr_result.get("flip", False)
        # OCR 文本识别（识别摆正后电视上的文字内容）
        ocr_texts, ocr_text_error = _ocr_read_texts(upright_img)
        ocr_result["texts"] = ocr_texts
        if ocr_text_error:
            ocr_result["text_error"] = ocr_text_error

    # --- Step 5: 计算最终旋转角度 ---
    angle = 0
    if need_rot90 and not need_flip180:
        angle = 90
    elif need_rot90 and need_flip180:
        angle = 270
    elif not need_rot90 and need_flip180:
        angle = 180

    confidence = round(best_score / img_area, 3) if best_rect is not None else 0.3
    confidence = min(confidence, 1.0)

    result = {
        "angle": angle,
        "confidence": confidence,
        "method": "contour",
        "need_rot90": need_rot90,
        "need_flip180": need_flip180,
        "tv_region": tv_region,
        "ocr_result": ocr_result,
        "params_used": p,
    }

    # --- 可视化标注 ---
    if annotate:
        annotated = img.copy()
        # 画所有轮廓
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < img_area * 0.05:
                cv2.drawContours(annotated, [cnt], -1, (0, 255, 0), 1)  # 小轮廓绿色细线
            else:
                cv2.drawContours(annotated, [cnt], -1, (255, 255, 0), 2)  # 大轮廓黄色

        if best_contour is not None:
            # 画最佳轮廓
            cv2.drawContours(annotated, [best_contour], -1, (0, 0, 255), 3)  # 红色粗线

            # 画 minAreaRect
            box = cv2.boxPoints(best_rect)
            box = np.int32(box)
            cv2.drawContours(annotated, [box], 0, (255, 0, 0), 2)  # 蓝色矩形

            # 画中心十字
            (cx, cy), (rw, rh), _ = best_rect
            cv2.drawMarker(annotated, (int(cx), int(cy)), (0, 255, 255), cv2.MARKER_CROSS, 20, 2)

            # 标注尺寸和角度
            label = f"TV: {int(rw)}x{int(rh)} rot={angle}"
            cv2.putText(annotated, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)

        # 标注 OCR 结果
        if ocr_result.get("error"):
            ocr_label = f"OCR error: {ocr_result['error'][:40]}"
            ocr_color = (0, 140, 255)
        elif ocr_result.get("label"):
            flip_txt = "FLIP 180" if ocr_result.get("flip") else "NORMAL"
            ocr_label = f"OCR[{ocr_result.get('strip')}]: {flip_txt} ({ocr_result.get('label')}, {ocr_result.get('score'):.2f})"
            ocr_color = (0, 0, 255) if ocr_result.get("flip") else (0, 255, 0)
        else:
            ocr_label = "OCR: no text detected"
            ocr_color = (0, 165, 255)
        cv2.putText(annotated, ocr_label, (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, ocr_color, 1)

        # 编码为 base64
        _, buf = cv2.imencode('.jpg', annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
        result["annotated_base64"] = base64.b64encode(buf).decode('ascii')

        # 生成自动旋转后的最终效果图
        if angle == 90:
            rotated = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
        elif angle == 180:
            rotated = cv2.rotate(img, cv2.ROTATE_180)
        elif angle == 270:
            rotated = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
        else:
            rotated = img
        _, rbuf = cv2.imencode('.jpg', rotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
        result["rotated_base64"] = base64.b64encode(rbuf).decode('ascii')

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect-tv-orientation.py [--json] [--annotate] [--params '...'] <image_path>"}), file=sys.stderr)
        sys.exit(1)

    args = sys.argv[1:]
    json_mode = False
    annotate_mode = False
    params = None
    path = None

    i = 0
    while i < len(args):
        if args[i] == "--json":
            json_mode = True
        elif args[i] == "--annotate":
            annotate_mode = True
        elif args[i] == "--params" and i + 1 < len(args):
            try:
                params = json.loads(args[i + 1])
            except Exception:
                pass
            i += 1
        else:
            path = args[i]
        i += 1

    if path is None:
        print(json.dumps({"error": "缺少图片路径"}), file=sys.stderr)
        sys.exit(1)

    # stdin 模式下强制 json（避免 print 干扰 stdout）
    if path == '-' and not json_mode:
        json_mode = True

    try:
        result = detect_tv_orientation(path, params=params, annotate=annotate_mode)
        if json_mode or "--json" in sys.argv:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if "error" not in result else 1)
    except Exception as e:
        print(json.dumps({"angle": 0, "confidence": 0, "method": "contour", "error": str(e)}))
        sys.exit(1)
