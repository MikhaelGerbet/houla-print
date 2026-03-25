/**
 * NIIMBOT label renderer — generates monochrome bitmaps from label data.
 *
 * Renders product labels into 1-bit packed bitmaps suitable for
 * NIIMBOT thermal printers (B1, B18, B21, etc.).
 *
 * Uses a built-in bitmap font for text and Code128 barcode generation.
 * No external image library required for basic labels.
 */

import { PrintLabelSize, LABEL_SIZE_OPTIONS } from '../../../shared/types';
import { NiimbotModelSpec, DEFAULT_MODEL } from './niimbot-protocol';

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

export interface LabelContent {
  productName: string;
  price?: string;          // e.g. "12,50 €"
  barcode?: string;        // Value to encode as Code128
  brandName?: string;
  sku?: string;
  variant?: string;        // e.g. "Taille M / Bleu"
}

export interface RenderedLabel {
  bitmap: Buffer;          // Packed 1-bit (MSB first)
  widthDots: number;
  heightDots: number;
}

/**
 * Render a product label as a monochrome 1-bit bitmap.
 */
export function renderProductLabel(
  content: LabelContent,
  labelSize: PrintLabelSize,
  model: NiimbotModelSpec = DEFAULT_MODEL,
): RenderedLabel {
  const dims = getLabelDimensions(labelSize, model.dpi);
  const w = Math.min(dims.widthDots, model.printWidthDots);
  const h = dims.heightDots;
  const bytesPerRow = Math.ceil(w / 8);
  const bitmap = Buffer.alloc(bytesPerRow * h, 0x00);

  const ctx = new BitmapCanvas(bitmap, w, h, bytesPerRow);

  // Layout depends on label size
  if (dims.isSmall) {
    renderSmallLabel(ctx, content, w, h);
  } else if (dims.isLarge) {
    renderLargeLabel(ctx, content, w, h);
  } else {
    renderStandardLabel(ctx, content, w, h);
  }

  return { bitmap, widthDots: w, heightDots: h };
}

// ═══════════════════════════════════════════════════════
// Label size → dots conversion
// ═══════════════════════════════════════════════════════

interface LabelDims {
  widthDots: number;
  heightDots: number;
  isSmall: boolean;
  isLarge: boolean;
}

function getLabelDimensions(size: PrintLabelSize, dpi: number): LabelDims {
  const dotsPerMm = dpi / 25.4;
  const [wMm, hMm] = size.split('x').map(Number);
  return {
    widthDots: Math.round(wMm * dotsPerMm),
    heightDots: Math.round(hMm * dotsPerMm),
    isSmall: wMm <= 50 && hMm <= 30,
    isLarge: wMm >= 100 && hMm >= 100,
  };
}

// ═══════════════════════════════════════════════════════
// Bitmap canvas helper
// ═══════════════════════════════════════════════════════

class BitmapCanvas {
  constructor(
    private bitmap: Buffer,
    public readonly width: number,
    public readonly height: number,
    public readonly bytesPerRow: number,
  ) {}

  /** Set a single pixel (black) */
  setPixel(x: number, y: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const byteIdx = y * this.bytesPerRow + Math.floor(x / 8);
    const bitIdx = 7 - (x % 8);
    this.bitmap[byteIdx] |= (1 << bitIdx);
  }

  /** Draw a filled rectangle */
  fillRect(x: number, y: number, w: number, h: number): void {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.setPixel(x + dx, y + dy);
      }
    }
  }

  /** Draw a horizontal line */
  hLine(x: number, y: number, length: number, thickness = 1): void {
    this.fillRect(x, y, length, thickness);
  }

  /** Draw text using the built-in 5×7 font at a given scale */
  drawText(text: string, x: number, y: number, scale = 1): number {
    const charW = 6 * scale;
    let cx = x;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const glyph = FONT_5X7[code] || FONT_5X7[0x3f];
      if (!glyph) { cx += charW; continue; }

      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy] & (1 << (4 - gx))) {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                this.setPixel(cx + gx * scale + sx, y + gy * scale + sy);
              }
            }
          }
        }
      }
      cx += charW;
    }
    return cx - x; // width drawn
  }

  /** Draw a bold text (draws at offset (0,0), (1,0), (0,1) for fake bold) */
  drawTextBold(text: string, x: number, y: number, scale = 1): number {
    this.drawText(text, x, y, scale);
    this.drawText(text, x + 1, y, scale);
    return this.drawText(text, x, y + 1, scale);
  }

  /** Draw a Code128B barcode */
  drawBarcode(value: string, x: number, y: number, barHeight: number, moduleWidth = 2): number {
    const encoded = encodeCode128B(value);
    let cx = x;
    for (const bar of encoded) {
      if (bar) {
        this.fillRect(cx, y, moduleWidth, barHeight);
      }
      cx += moduleWidth;
    }
    return cx - x;
  }
}

// ═══════════════════════════════════════════════════════
// Label layouts
// ═══════════════════════════════════════════════════════

/** Small labels: 40×30, 50×25 — product name + price only */
function renderSmallLabel(ctx: BitmapCanvas, content: LabelContent, w: number, h: number): void {
  const margin = 8;

  // Product name (truncate if too long)
  const maxChars = Math.floor((w - margin * 2) / 12); // scale=2, 6px per char
  const name = truncate(content.productName, maxChars);
  ctx.drawTextBold(name, margin, margin, 2);

  // Variant line
  let yOffset = margin + 18;
  if (content.variant) {
    const variantText = truncate(content.variant, maxChars);
    ctx.drawText(variantText, margin, yOffset, 1);
    yOffset += 10;
  }

  // Price (large)
  if (content.price) {
    ctx.drawTextBold(content.price, margin, h - margin - 16, 2);
  }
}

/** Standard labels: 57×32, 100×50 — name, variant, price, barcode */
function renderStandardLabel(ctx: BitmapCanvas, content: LabelContent, w: number, h: number): void {
  const margin = 10;
  let y = margin;

  // Brand name (small)
  if (content.brandName) {
    ctx.drawText(content.brandName.toUpperCase(), margin, y, 1);
    y += 12;
  }

  // Separator line
  ctx.hLine(margin, y, w - margin * 2, 1);
  y += 4;

  // Product name (bold, scale 2)
  const maxChars = Math.floor((w - margin * 2) / 12);
  const name = truncate(content.productName, maxChars);
  ctx.drawTextBold(name, margin, y, 2);
  y += 20;

  // Second line for long names
  if (content.productName.length > maxChars) {
    const secondLine = truncate(content.productName.substring(maxChars), maxChars);
    ctx.drawText(secondLine, margin, y, 2);
    y += 18;
  }

  // Variant
  if (content.variant) {
    ctx.drawText(content.variant, margin, y, 1);
    y += 12;
  }

  // SKU
  if (content.sku) {
    ctx.drawText(`REF: ${content.sku}`, margin, y, 1);
    y += 12;
  }

  // Bottom section: price + barcode
  const bottomY = h - margin;

  // Price (large, bottom-left)
  if (content.price) {
    ctx.drawTextBold(content.price, margin, bottomY - 16, 2);
  }

  // Barcode (bottom-right, if space)
  if (content.barcode && w > 250) {
    const barcodeWidth = content.barcode.length * 11 * 2; // rough estimate
    const barcodeX = w - margin - barcodeWidth;
    const barcodeY = bottomY - 40;
    if (barcodeX > w / 2) {
      ctx.drawBarcode(content.barcode, barcodeX, barcodeY, 30, 1);
      ctx.drawText(content.barcode, barcodeX, barcodeY + 32, 1);
    }
  }
}

/** Large labels: 100×100, 100×150 — full layout with barcode */
function renderLargeLabel(ctx: BitmapCanvas, content: LabelContent, w: number, h: number): void {
  const margin = 16;
  let y = margin;

  // Brand name header
  if (content.brandName) {
    ctx.drawTextBold(content.brandName.toUpperCase(), margin, y, 2);
    y += 24;
    ctx.hLine(margin, y, w - margin * 2, 2);
    y += 8;
  }

  // Product name (large, bold)
  const maxChars3 = Math.floor((w - margin * 2) / 18); // scale=3
  const name = truncate(content.productName, maxChars3);
  ctx.drawTextBold(name, margin, y, 3);
  y += 28;

  // Wrap to second line if needed
  if (content.productName.length > maxChars3) {
    const line2 = truncate(content.productName.substring(maxChars3), maxChars3);
    ctx.drawText(line2, margin, y, 3);
    y += 28;
  }

  y += 8;

  // Variant
  if (content.variant) {
    ctx.drawText(content.variant, margin, y, 2);
    y += 22;
  }

  // SKU
  if (content.sku) {
    ctx.drawText(`REF: ${content.sku}`, margin, y, 1);
    y += 14;
  }

  // Price section (centered, very large)
  if (content.price) {
    y += 8;
    ctx.hLine(margin, y, w - margin * 2, 1);
    y += 8;
    const priceScale = 4;
    const priceWidth = content.price.length * 6 * priceScale;
    const priceX = Math.floor((w - priceWidth) / 2);
    ctx.drawTextBold(content.price, priceX, y, priceScale);
    y += 7 * priceScale + 8;
  }

  // Barcode at bottom
  if (content.barcode) {
    y = Math.max(y + 8, h - margin - 60);
    ctx.hLine(margin, y, w - margin * 2, 1);
    y += 6;
    const moduleW = 2;
    const barcodePixels = encodeCode128B(content.barcode);
    const barcodeWidth = barcodePixels.length * moduleW;
    const barcodeX = Math.floor((w - barcodeWidth) / 2);
    ctx.drawBarcode(content.barcode, barcodeX, y, 40, moduleW);
    y += 44;
    // Barcode text centered below
    const textWidth = content.barcode.length * 6;
    const textX = Math.floor((w - textWidth) / 2);
    ctx.drawText(content.barcode, textX, y, 1);
  }
}

// ═══════════════════════════════════════════════════════
// Code128B barcode encoding
// ═══════════════════════════════════════════════════════

const CODE128_PATTERNS: number[][] = [
  // Each pattern: 6 elements (bar, space, bar, space, bar, space) widths
  [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],
  [1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],
  [2,2,1,3,1,2],[2,3,1,2,1,2],[1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],
  [1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
  [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],[3,1,1,2,2,2],
  [3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
  [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],
  [1,3,1,3,2,1],[1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
  [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
  [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[3,1,3,1,2,1],[2,1,1,3,3,1],
  [2,3,1,1,3,1],[2,1,3,1,1,3],[2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],
  [3,1,1,3,2,1],[3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
  [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],
  [1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],[1,4,1,2,2,1],[1,1,2,2,1,4],
  [1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],
  [2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
  [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],
  [1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],
  [2,1,4,1,2,1],[4,1,2,1,2,1],[1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],
  [1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
  [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],[2,1,1,2,1,4],
  [2,1,1,2,3,2],[2,3,3,1,1,1],
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

/** Encode a string as Code128B → returns array of bar/space booleans */
function encodeCode128B(value: string): boolean[] {
  const codes: number[] = [CODE128_START_B];
  let checksum = CODE128_START_B;

  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i) - 32;
    if (code < 0 || code > 95) continue; // skip invalid
    codes.push(code);
    checksum += code * (i + 1);
  }

  codes.push(checksum % 103);
  codes.push(CODE128_STOP);

  // Convert to bars
  const bars: boolean[] = [];
  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    if (!pattern) continue;
    for (let j = 0; j < pattern.length; j++) {
      const isBar = j % 2 === 0; // even indices = bars, odd = spaces
      for (let k = 0; k < pattern[j]; k++) {
        bars.push(isBar);
      }
    }
  }

  // Stop pattern has an extra bar
  bars.push(true, true);

  return bars;
}

// ═══════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '.';
}

// ═══════════════════════════════════════════════════════
// 5×7 bitmap font (ASCII 32–126)
// ═══════════════════════════════════════════════════════

const FONT_5X7: Record<number, number[]> = {
  0x20: [0x00,0x00,0x00,0x00,0x00,0x00,0x00],
  0x21: [0x04,0x04,0x04,0x04,0x04,0x00,0x04],
  0x22: [0x0a,0x0a,0x00,0x00,0x00,0x00,0x00],
  0x23: [0x0a,0x1f,0x0a,0x0a,0x1f,0x0a,0x00],
  0x24: [0x04,0x0f,0x14,0x0e,0x05,0x1e,0x04],
  0x25: [0x18,0x19,0x02,0x04,0x08,0x13,0x03],
  0x27: [0x04,0x04,0x00,0x00,0x00,0x00,0x00],
  0x28: [0x02,0x04,0x08,0x08,0x08,0x04,0x02],
  0x29: [0x08,0x04,0x02,0x02,0x02,0x04,0x08],
  0x2b: [0x00,0x04,0x04,0x1f,0x04,0x04,0x00],
  0x2c: [0x00,0x00,0x00,0x00,0x00,0x04,0x08],
  0x2d: [0x00,0x00,0x00,0x1f,0x00,0x00,0x00],
  0x2e: [0x00,0x00,0x00,0x00,0x00,0x00,0x04],
  0x2f: [0x01,0x02,0x04,0x04,0x08,0x10,0x00],
  0x30: [0x0e,0x11,0x13,0x15,0x19,0x11,0x0e],
  0x31: [0x04,0x0c,0x04,0x04,0x04,0x04,0x0e],
  0x32: [0x0e,0x11,0x01,0x06,0x08,0x10,0x1f],
  0x33: [0x0e,0x11,0x01,0x06,0x01,0x11,0x0e],
  0x34: [0x02,0x06,0x0a,0x12,0x1f,0x02,0x02],
  0x35: [0x1f,0x10,0x1e,0x01,0x01,0x11,0x0e],
  0x36: [0x06,0x08,0x10,0x1e,0x11,0x11,0x0e],
  0x37: [0x1f,0x01,0x02,0x04,0x08,0x08,0x08],
  0x38: [0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e],
  0x39: [0x0e,0x11,0x11,0x0f,0x01,0x02,0x0c],
  0x3a: [0x00,0x00,0x04,0x00,0x04,0x00,0x00],
  0x3f: [0x0e,0x11,0x01,0x02,0x04,0x00,0x04],
  0x41: [0x0e,0x11,0x11,0x1f,0x11,0x11,0x11],
  0x42: [0x1e,0x11,0x11,0x1e,0x11,0x11,0x1e],
  0x43: [0x0e,0x11,0x10,0x10,0x10,0x11,0x0e],
  0x44: [0x1e,0x11,0x11,0x11,0x11,0x11,0x1e],
  0x45: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x1f],
  0x46: [0x1f,0x10,0x10,0x1e,0x10,0x10,0x10],
  0x47: [0x0e,0x11,0x10,0x17,0x11,0x11,0x0e],
  0x48: [0x11,0x11,0x11,0x1f,0x11,0x11,0x11],
  0x49: [0x0e,0x04,0x04,0x04,0x04,0x04,0x0e],
  0x4a: [0x07,0x02,0x02,0x02,0x02,0x12,0x0c],
  0x4b: [0x11,0x12,0x14,0x18,0x14,0x12,0x11],
  0x4c: [0x10,0x10,0x10,0x10,0x10,0x10,0x1f],
  0x4d: [0x11,0x1b,0x15,0x11,0x11,0x11,0x11],
  0x4e: [0x11,0x19,0x15,0x13,0x11,0x11,0x11],
  0x4f: [0x0e,0x11,0x11,0x11,0x11,0x11,0x0e],
  0x50: [0x1e,0x11,0x11,0x1e,0x10,0x10,0x10],
  0x51: [0x0e,0x11,0x11,0x11,0x15,0x12,0x0d],
  0x52: [0x1e,0x11,0x11,0x1e,0x14,0x12,0x11],
  0x53: [0x0e,0x11,0x10,0x0e,0x01,0x11,0x0e],
  0x54: [0x1f,0x04,0x04,0x04,0x04,0x04,0x04],
  0x55: [0x11,0x11,0x11,0x11,0x11,0x11,0x0e],
  0x56: [0x11,0x11,0x11,0x0a,0x0a,0x04,0x04],
  0x57: [0x11,0x11,0x11,0x15,0x15,0x1b,0x11],
  0x58: [0x11,0x11,0x0a,0x04,0x0a,0x11,0x11],
  0x59: [0x11,0x11,0x0a,0x04,0x04,0x04,0x04],
  0x5a: [0x1f,0x01,0x02,0x04,0x08,0x10,0x1f],
  0x61: [0x00,0x00,0x0e,0x01,0x0f,0x11,0x0f],
  0x62: [0x10,0x10,0x1e,0x11,0x11,0x11,0x1e],
  0x63: [0x00,0x00,0x0e,0x11,0x10,0x11,0x0e],
  0x64: [0x01,0x01,0x0f,0x11,0x11,0x11,0x0f],
  0x65: [0x00,0x00,0x0e,0x11,0x1f,0x10,0x0e],
  0x66: [0x06,0x09,0x08,0x1e,0x08,0x08,0x08],
  0x67: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x0e],
  0x68: [0x10,0x10,0x16,0x19,0x11,0x11,0x11],
  0x69: [0x04,0x00,0x0c,0x04,0x04,0x04,0x0e],
  0x6a: [0x02,0x00,0x06,0x02,0x02,0x12,0x0c],
  0x6b: [0x10,0x10,0x12,0x14,0x18,0x14,0x12],
  0x6c: [0x0c,0x04,0x04,0x04,0x04,0x04,0x0e],
  0x6d: [0x00,0x00,0x1a,0x15,0x15,0x11,0x11],
  0x6e: [0x00,0x00,0x16,0x19,0x11,0x11,0x11],
  0x6f: [0x00,0x00,0x0e,0x11,0x11,0x11,0x0e],
  0x70: [0x00,0x00,0x1e,0x11,0x1e,0x10,0x10],
  0x71: [0x00,0x00,0x0f,0x11,0x0f,0x01,0x01],
  0x72: [0x00,0x00,0x16,0x19,0x10,0x10,0x10],
  0x73: [0x00,0x00,0x0e,0x10,0x0e,0x01,0x1e],
  0x74: [0x08,0x08,0x1e,0x08,0x08,0x09,0x06],
  0x75: [0x00,0x00,0x11,0x11,0x11,0x13,0x0d],
  0x76: [0x00,0x00,0x11,0x11,0x0a,0x0a,0x04],
  0x77: [0x00,0x00,0x11,0x11,0x15,0x15,0x0a],
  0x78: [0x00,0x00,0x11,0x0a,0x04,0x0a,0x11],
  0x79: [0x00,0x00,0x11,0x11,0x0f,0x01,0x0e],
  0x7a: [0x00,0x00,0x1f,0x02,0x04,0x08,0x1f],
  // Euro sign (€ = 0x20AC, mapped to a custom slot)
  0x80: [0x06,0x09,0x1e,0x08,0x1e,0x09,0x06],
};

// Map € to our custom slot
FONT_5X7[0x20ac] = FONT_5X7[0x80]!;
