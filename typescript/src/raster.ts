// Separable Lanczos with the same 22-bit coefficient quantization as Pillow.
// Decoding/encoding uses libvips; resampling does not substitute a different kernel.
export type Raster = { width: number; height: number; data: Uint8Array };

const PRECISION = 1 << 22,
  HALF = 1 << 21;

/** Pillow's quantized Lanczos-3 taps for each output pixel. */
function coefficients(input: number, output: number) {
  const scale = input / output,
    filter = Math.max(1, scale),
    support = 3 * filter;
  const sinc = (x: number) =>
    x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
  return Array.from({ length: output }, (_, i) => {
    const center = (i + 0.5) * scale,
      start = Math.max(0, Math.trunc(center - support + 0.5)),
      end = Math.min(input, Math.trunc(center + support + 0.5));
    const weights = [];
    let sum = 0;
    for (let j = start; j < end; j++) {
      const x = (j - center + 0.5) / filter,
        v = Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0;
      weights.push(v);
      sum += v;
    }
    return {
      start,
      weights: weights.map((v) =>
        Math.trunc((v / sum) * PRECISION + (v < 0 ? -0.5 : 0.5)),
      ),
    };
  });
}

const toByte = (sum: number) =>
  Math.max(0, Math.min(255, Math.floor(sum / PRECISION)));

/** Resize RGB pixels horizontally, then vertically, as Pillow does. */
export function resizeRGB(img: Raster, width: number, height: number): Raster {
  let { data } = img,
    w = img.width,
    h = img.height;
  if (w !== width) {
    const out = new Uint8Array(width * h * 3),
      cs = coefficients(w, width);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < width; x++) {
        const { start, weights } = cs[x],
          base = (y * w + start) * 3;
        for (let c = 0; c < 3; c++) {
          let sum = HALF;
          for (let k = 0; k < weights.length; k++)
            sum += data[base + k * 3 + c] * weights[k];
          out[(y * width + x) * 3 + c] = toByte(sum);
        }
      }
    data = out;
    w = width;
  }
  if (h !== height) {
    const out = new Uint8Array(w * height * 3),
      cs = coefficients(h, height);
    for (let y = 0; y < height; y++) {
      const { start, weights } = cs[y];
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let sum = HALF;
          for (let k = 0; k < weights.length; k++)
            sum += data[((start + k) * w + x) * 3 + c] * weights[k];
          out[(y * w + x) * 3 + c] = toByte(sum);
        }
    }
    data = out;
    h = height;
  }
  return { width: w, height: h, data };
}
