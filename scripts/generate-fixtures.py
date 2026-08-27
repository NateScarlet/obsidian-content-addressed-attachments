"""
Script to generate synthetic test fixtures with clear 100% open/synthetic license.
"""
from PIL import Image, ImageDraw
import pillow_heif

def generate_fixtures():
    pillow_heif.register_heif_opener()

    # Generate PNG fixture
    img_png = Image.new('RGB', (128, 128), color=(73, 109, 137))
    d_png = ImageDraw.Draw(img_png)
    d_png.rectangle([(10, 10), (118, 118)], outline=(255, 255, 255), width=3)
    img_png.save('tests/e2e-vault/fixtures/sample.png')
    print("Generated tests/e2e-vault/fixtures/sample.png")

    # Generate HEIC fixture
    img_heic = Image.new('RGB', (128, 128), color=(34, 139, 34))
    d_heic = ImageDraw.Draw(img_heic)
    d_heic.rectangle([(10, 10), (118, 118)], outline=(255, 255, 255), width=3)
    img_heic.save('tests/e2e-vault/fixtures/sample.heic', format='HEIF')
    print("Generated tests/e2e-vault/fixtures/sample.heic")

if __name__ == "__main__":
    generate_fixtures()
