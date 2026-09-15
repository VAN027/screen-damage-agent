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


if __name__ == "__main__":
    unittest.main()
