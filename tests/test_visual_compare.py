"""Raster tolerances must accept rendering changes and reject local drawing edits."""

import sys
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import visual_compare as visual


class VisualComparisonTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.image = self.drawing()
        self.reference = self.root / "reference.png"
        self.image.save(self.reference)

    @staticmethod
    def drawing(label="ABC", arrow=True, color="blue", width=3):
        im = Image.new("RGB", (500, 300), "white")
        draw = ImageDraw.Draw(im)
        draw.rectangle((30, 30, 460, 260), outline="black", width=width)
        draw.line((100, 140, 390, 140), fill="black", width=width)
        if arrow:
            draw.polygon([(390, 140), (378, 132), (378, 148)], fill="black")
        draw.ellipse((120, 160, 200, 230), outline=color, width=width)
        draw.text((230, 90), label, fill="black", font_size=28)
        draw.rectangle((290, 185, 350, 230), fill=(170, 170, 170))
        return im

    def compare(self, image):
        candidate = self.root / "candidate.png"
        image.save(candidate)
        return visual.compare(self.reference, candidate, self.root / "grade")

    def test_identity_padding_uniform_scale_and_alpha_margins_pass(self):
        padded = Image.new("RGB", (800, 600), "white")
        padded.paste(self.image, (120, 130))
        transparent = Image.new("RGBA", (800, 600), (0, 0, 0, 0))
        transparent.paste(self.image, (120, 130))
        for image in [self.image, padded, transparent,
                      self.image.resize((750, 450), Image.Resampling.LANCZOS)]:
            with self.subTest(size=image.size, mode=image.mode):
                result = self.compare(image)
                self.assertTrue(result["exact_match"], result["differences"])
                self.assertEqual(set(result["artifacts"]), {"reference", "candidate", "difference"})

    def test_small_local_edits_do_not_hide_in_blank_space_or_global_averages(self):
        wrong_fill = self.image.copy()
        ImageDraw.Draw(wrong_fill).rectangle((290, 185, 350, 230), fill=(185, 185, 185))
        extra = self.image.copy()
        ImageDraw.Draw(extra).text((330, 55), "PASS", fill="black", font_size=20)
        for name, image in {
            "arrow": self.drawing(arrow=False), "label": self.drawing(label="ADC"),
            "color": self.drawing(color="red"), "width": self.drawing(width=6),
            "fill": wrong_fill, "extra instructions": extra,
            "stretch": self.image.resize((580, 300)),
            "rotation": self.image.rotate(3, fillcolor="white"),
            "reflection": self.image.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
            "blank": Image.new("RGB", self.image.size, "white"),
        }.items():
            with self.subTest(change=name):
                result = self.compare(image)
                self.assertFalse(result["exact_match"], result["metrics"])
                self.assertTrue(result["differences"])

    def test_output_is_repeatable_and_empty_reference_is_a_data_error(self):
        first = self.compare(self.drawing(label="ADC"))
        self.assertEqual(first, self.compare(self.drawing(label="ADC")))
        Image.new("RGB", (100, 100), "white").save(self.reference)
        with self.assertRaisesRegex(ValueError, "reference image"):
            self.compare(self.image)

    def test_recovered_originals_match_across_rasterization_resolutions(self):
        originals = Path(__file__).resolve().parents[1] / "sources/arxiv_source_audit_2026_09/recovered_tikz"
        pdfs = sorted(originals.glob("*.pdf"))
        if len(pdfs) != 5 or not shutil.which("pdftoppm"):
            self.skipTest("five private recovered TikZ originals and Poppler required")
        for pdf in pdfs:
            with self.subTest(figure=pdf.stem):
                for dpi in (200, 300):
                    subprocess.run(["pdftoppm", "-r", str(dpi), "-png", "-singlefile",
                                    str(pdf), str(self.root / str(dpi))],
                                   check=True, capture_output=True, timeout=30)
                result = visual.compare(self.root / "200.png", self.root / "300.png")
                self.assertTrue(result["exact_match"], result["differences"])


if __name__ == "__main__":
    unittest.main()
