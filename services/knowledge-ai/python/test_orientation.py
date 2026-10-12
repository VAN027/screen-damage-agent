import unittest
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from orientation import detect_tv_orientation


def synthetic_tv(vertical: bool = False) -> Image.Image:
    image = np.full((900, 1200, 3), 235, dtype=np.uint8)
    cv2.rectangle(image, (120, 220), (1080, 760), (20, 20, 20), 18)
    if vertical:
        image = cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def synthetic_tv_with_broken_bezel() -> Image.Image:
    image = np.full((900, 1200, 3), 235, dtype=np.uint8)
    cv2.rectangle(image, (120, 220), (1080, 760), (20, 20, 20), 5)
    # Six gaps wider than the normal 7x7 closing pass can bridge.
    for start, end in [
        ((350, 217), (376, 223)), ((740, 217), (766, 223)),
        ((350, 757), (376, 763)), ((740, 757), (766, 763)),
        ((117, 400), (123, 426)), ((1077, 530), (1083, 556)),
    ]:
        cv2.rectangle(image, start, end, (235, 235, 235), 7)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def synthetic_tv_with_perspective() -> Image.Image:
    image = np.full((900, 1200, 3), 235, dtype=np.uint8)
    corners = np.array([[170, 260], [1050, 170], [980, 740], [260, 690]], dtype=np.int32)
    cv2.polylines(image, [corners], True, (20, 20, 20), 18)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


def synthetic_partial_tv() -> Image.Image:
    image = np.full((900, 1200, 3), 235, dtype=np.uint8)
    cv2.line(image, (100, 180), (1000, 180), (20, 20, 20), 8)
    cv2.line(image, (100, 720), (1000, 720), (20, 20, 20), 8)
    cv2.line(image, (1080, 260), (1080, 640), (20, 20, 20), 8)
    return Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))


class TVOrientationGeometryTests(unittest.TestCase):
    def test_horizontal_tv_does_not_rotate(self):
        result = detect_tv_orientation(synthetic_tv(), use_ocr=False)
        self.assertTrue(result["tvDetected"])
        self.assertEqual(result["baseRotation"], 0)
        self.assertEqual(result["tvRegion"]["longAxis"], "horizontal")
        self.assertGreaterEqual(result["geometryConfidence"], 0.62)

    def test_vertical_tv_rotates_clockwise(self):
        result = detect_tv_orientation(synthetic_tv(vertical=True), use_ocr=False)
        self.assertTrue(result["tvDetected"])
        self.assertEqual(result["baseRotation"], 90)
        self.assertEqual(result["tvRegion"]["longAxis"], "vertical")

    def test_portrait_photo_without_tv_never_uses_photo_aspect_fallback(self):
        blank = Image.fromarray(np.full((1200, 600, 3), 255, dtype=np.uint8))
        result = detect_tv_orientation(blank, use_ocr=False)
        self.assertFalse(result["tvDetected"])
        self.assertEqual(result["baseRotation"], 0)
        self.assertTrue(result["requiresConfirmation"])

    def test_adaptive_closing_recovers_broken_tv_bezel(self):
        result = detect_tv_orientation(synthetic_tv_with_broken_bezel(), use_ocr=False, include_debug=True)
        self.assertTrue(result["tvDetected"])
        self.assertEqual(result["debug"]["closing"], "自适应 Closing 21×21 ×2")

    def test_perspective_quadrilateral_is_not_forced_to_rectangle(self):
        result = detect_tv_orientation(synthetic_tv_with_perspective(), use_ocr=False)
        self.assertTrue(result["tvDetected"])
        self.assertEqual(result["tvRegion"]["detectionMethod"], "perspective-quadrilateral")
        self.assertEqual(result["tvRegion"]["longAxis"], "horizontal")

    def test_partial_tv_uses_visible_line_inference(self):
        result = detect_tv_orientation(synthetic_partial_tv(), use_ocr=False, include_debug=True)
        self.assertTrue(result["tvDetected"])
        self.assertTrue(result["tvRegion"]["partial"])
        self.assertEqual(result["tvRegion"]["detectionMethod"], "partial-lines")
        self.assertGreaterEqual(len(result["debug"]["partialLines"]), 3)
        self.assertLessEqual(result["geometryConfidence"], 0.72)


if __name__ == "__main__":
    unittest.main()
