/**
 * NIIMBOT label renderer — generates monochrome bitmaps from label data.
 * V2: Enhanced content with order/customer info, QR codes, and adaptive layouts.
 *
 * Renders product labels into 1-bit packed bitmaps suitable for
 * NIIMBOT thermal printers (B1, B18, B21, etc.).
 */

import qrcode from 'qrcode-generator';
import { PrintLabelSize } from '../../../shared/types';
import { NiimbotModelSpec, DEFAULT_MODEL } from './niimbot-protocol';

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

export interface LabelContent {
  // Product
  productName: string;
  productDescription?: string; // Free-form description (generic/custom products)
  variant?: string;           // "Taille M / Rouge"
  sku?: string;
  price?: string;             // "29.99€"
  originalPrice?: string;     // "39.99€" (struck-through if different from price)
  barcode?: string;           // Code128 barcode value

  // Order
  orderId?: string;           // "#37514"
  orderDate?: string;         // "14/09/2025"
  orderTotal?: string;        // "89.97€"
  quantityFraction?: string;  // "1/3"

  // Customer
  customerName?: string;      // "Mercedes Villa"
  socialHandle?: string;      // "@mercedes.tt"
  country?: string;           // "France"

  // QR & Brand
  qrCodeUrl?: string;         // Short link with smart routing
  brandName?: string;
  websiteUrl?: string;        // "www.giamory.com"
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
  labelSize: string,
  model: NiimbotModelSpec = DEFAULT_MODEL,
): RenderedLabel {
  const dims = getLabelDimensions(labelSize, model.dpi);
  const w = Math.min(dims.widthDots, model.printWidthDots);
  const h = dims.heightDots;
  const bytesPerRow = Math.ceil(w / 8);
  const bitmap = Buffer.alloc(bytesPerRow * h, 0x00);

  const ctx = new BitmapCanvas(bitmap, w, h, bytesPerRow);

  if (dims.heightMm <= 30) {
    renderSmallLabel(ctx, content, w, h);
  } else if (dims.heightMm >= 80) {
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
  widthMm: number;
  heightMm: number;
}

function getLabelDimensions(size: string, dpi: number): LabelDims {
  const dotsPerMm = dpi / 25.4;
  const [wMm, hMm] = size.split('x').map(Number);
  return {
    widthDots: Math.round(wMm * dotsPerMm),
    heightDots: Math.round(hMm * dotsPerMm),
    widthMm: wMm,
    heightMm: hMm,
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

  /** Draw right-aligned text, returns the x position where text starts */
  drawTextRight(text: string, rightX: number, y: number, scale = 1): number {
    const textWidth = text.length * 6 * scale;
    const x = rightX - textWidth;
    this.drawText(text, x, y, scale);
    return x;
  }

  /** Draw right-aligned bold text */
  drawTextBoldRight(text: string, rightX: number, y: number, scale = 1): number {
    const textWidth = text.length * 6 * scale;
    const x = rightX - textWidth;
    this.drawTextBold(text, x, y, scale);
    return x;
  }

  /** Draw text with a strikethrough line */
  drawTextStrikethrough(text: string, x: number, y: number, scale = 1): number {
    const w = this.drawText(text, x, y, scale);
    const midY = y + Math.floor(7 * scale / 2);
    this.hLine(x, midY, w, scale);
    return w;
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

  /** Draw a QR code at position (x, y) with given module size in dots. Returns size in dots. */
  drawQrCode(url: string, x: number, y: number, moduleSize: number): number {
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const count = qr.getModuleCount();
    const size = count * moduleSize;
    // Draw quiet zone (2-module white border is implicit since bitmap is white)
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          this.fillRect(
            x + col * moduleSize,
            y + row * moduleSize,
            moduleSize,
            moduleSize,
          );
        }
      }
    }
    return size;
  }

  /** Compute QR code size without drawing it */
  static qrCodeSize(url: string, moduleSize: number): number {
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    return qr.getModuleCount() * moduleSize;
  }
}

// ═══════════════════════════════════════════════════════
// Label layouts
// ═══════════════════════════════════════════════════════

/**
 * Small labels (h ≤ 30mm): adaptive layout with readable text sizes.
 * All text scale ≥ 2 (1.75mm at 203 DPI). Product name and price scale 3 when space allows.
 * QR code top-right, content distributed proportionally, price bar at bottom.
 */
function renderSmallLabel(ctx: BitmapCanvas, c: LabelContent, w: number, h: number): void {
  const m = 6;
  const fullW = w - m * 2;

  // ---- QR code layout (top-right corner) ----
  let qrSize = 0;
  let textW = fullW;
  if (c.qrCodeUrl && w >= 200) {
    const modSize = h >= 200 ? 3 : 2;
    qrSize = BitmapCanvas.qrCodeSize(c.qrCodeUrl, modSize);
    const qrX = w - m - qrSize;
    ctx.drawQrCode(c.qrCodeUrl, qrX, m, modSize);
    textW = qrX - m - 6;
  }

  // ---- Determine scale based on available height ----
  // Price bar: scale 3 price = 21px + 6px margin = 27
  const priceScale = h >= 180 ? 3 : 2;
  const priceBarH = priceScale * 7 + 6;
  const availH = h - m * 2 - priceBarH;

  // Adaptive text scales: try scale 2 for body, scale 3 for product name
  // Fall back to scale 2 everywhere if tight, or scale 1 if very tight
  let bodyScale = 2;
  let nameScale = h >= 180 ? 3 : 2;

  // Estimate total content height to check if it fits
  const estimateH = (ns: number, bs: number): number => {
    let est = 0;
    if (c.orderId) est += bs * 7 + 3;
    est += 4; // separator
    est += ns * 7 + 3; // product name
    if (c.productDescription) est += bs * 7 + 3;
    if (c.variant) est += bs * 7 + 3;
    if (c.sku) est += bs * 7 + 3;
    est += 4; // separator
    if (c.socialHandle) est += ns * 7 + 3;
    if (c.customerName) est += ns * 7 + 3;
    if (c.country) est += bs * 7 + 3;
    return est;
  };

  // Scale down if content doesn't fit
  if (estimateH(nameScale, bodyScale) > availH) {
    nameScale = 2;
  }
  if (estimateH(nameScale, bodyScale) > availH) {
    bodyScale = 1;
  }
  if (estimateH(nameScale, bodyScale) > availH) {
    nameScale = 1;
  }

  const maxCharsN = Math.floor(textW / (6 * nameScale));
  const maxCharsB = Math.floor(textW / (6 * bodyScale));

  // ---- Build content lines ----
  const lines: { text: string; scale: number; bold: boolean }[] = [];

  // Order info
  if (c.orderId) {
    let orderStr = c.orderId;
    if (c.orderDate) orderStr += '  ' + c.orderDate;
    lines.push({ text: truncate(orderStr, maxCharsB), scale: bodyScale, bold: true });
  }

  lines.push({ text: '__SEP__', scale: 0, bold: false });

  // Product name (largest scale)
  lines.push({ text: truncate(c.productName, maxCharsN), scale: nameScale, bold: true });

  // Product description (free-form, 1 line truncated)
  if (c.productDescription) {
    lines.push({ text: truncate(c.productDescription, maxCharsB), scale: bodyScale, bold: false });
  }

  // Variant
  if (c.variant) {
    lines.push({ text: truncate(c.variant, maxCharsB), scale: bodyScale, bold: false });
  }

  // SKU
  if (c.sku) {
    lines.push({ text: truncate('REF: ' + c.sku, maxCharsB), scale: bodyScale, bold: false });
  }

  lines.push({ text: '__SEP__', scale: 0, bold: false });

  // Customer — social handle + name at nameScale for readability
  if (c.socialHandle) {
    lines.push({ text: truncate(c.socialHandle, maxCharsN), scale: nameScale, bold: true });
  }
  if (c.customerName) {
    lines.push({ text: truncate(c.customerName, maxCharsN), scale: nameScale, bold: true });
  }

  // Country
  if (c.country) {
    lines.push({ text: c.country, scale: bodyScale, bold: false });
  }

  // ---- Calculate total content height and distribute gaps ----
  const lineHeights = lines.map(l => {
    if (l.text === '__SEP__') return 4;
    return l.scale * 7 + 3;
  });
  const totalContentH = lineHeights.reduce((a, b) => a + b, 0);

  const extraSpace = Math.max(0, availH - totalContentH);
  const sectionCount = lines.filter(l => l.text === '__SEP__').length + 1;
  const sectionGap = Math.floor(extraSpace / Math.max(sectionCount, 1));

  // ---- Render content lines ----
  let y = m;
  for (const line of lines) {
    if (line.text === '__SEP__') {
      y += Math.floor(sectionGap / 2);
      ctx.hLine(m, y, textW, 1);
      y += 4 + Math.floor(sectionGap / 2);
      continue;
    }
    if (line.bold) {
      ctx.drawTextBold(line.text, m, y, line.scale);
    } else {
      ctx.drawText(line.text, m, y, line.scale);
    }
    y += line.scale * 7 + 3;
  }

  // ---- Bottom bar: price (right-aligned, grouped) + quantity (left) ----
  const bottomY = h - m - priceBarH;
  ctx.hLine(m, bottomY - 2, fullW, 1);

  if (c.price) {
    const pw = c.price.length * 6 * priceScale;
    const px = m + fullW - pw;
    ctx.drawTextBold(c.price, px, bottomY + 2, priceScale);

    // Strikethrough original price, scale bodyScale, just left of main price
    if (c.originalPrice && c.originalPrice !== c.price) {
      const origW = c.originalPrice.length * 6 * bodyScale + 6;
      const origY = bottomY + 2 + Math.floor((priceScale * 7 - bodyScale * 7) / 2);
      ctx.drawTextStrikethrough(c.originalPrice, px - origW, origY, bodyScale);
    }
  }

  if (c.quantityFraction) {
    const qtyY = bottomY + 2 + Math.floor((priceScale * 7 - bodyScale * 7) / 2);
    ctx.drawText(c.quantityFraction, m, qtyY, bodyScale);
  }
}

/**
 * Standard labels (30 < h < 80mm): full info with optional QR code.
 * Two-column layout when QR is available.
 */
function renderStandardLabel(ctx: BitmapCanvas, c: LabelContent, w: number, h: number): void {
  const m = 8;

  // QR column on the right if URL provided
  const qrModuleSize = 3;
  let qrSize = 0;
  let textW = w - m * 2;

  if (c.qrCodeUrl && w >= 280) {
    qrSize = BitmapCanvas.qrCodeSize(c.qrCodeUrl, qrModuleSize);
    const qrColW = qrSize + 8; // 8px gap
    textW = w - m - qrColW - 4;
    const qrX = w - m - qrSize;
    ctx.drawQrCode(c.qrCodeUrl, qrX, m, qrModuleSize);
  }

  const maxChars2 = Math.floor(textW / 12);
  const maxChars1 = Math.floor(textW / 6);
  let y = m;

  // Header line: brand + order info
  if (c.brandName) {
    ctx.drawText(c.brandName.toUpperCase(), m, y, 1);
  }
  if (c.orderId) {
    const orderInfo = c.orderId + (c.orderDate ? '  ' + c.orderDate : '');
    const infoW = orderInfo.length * 6;
    const infoX = Math.min(m + textW - infoW, w - m - infoW);
    if (infoX > m + (c.brandName?.length || 0) * 6 + 6) {
      ctx.drawText(orderInfo, infoX, y, 1);
    }
  }
  y += 12;

  // Separator
  ctx.hLine(m, y, textW, 1);
  y += 4;

  // Product name (bold, scale 2)
  const name1 = truncate(c.productName, maxChars2);
  ctx.drawTextBold(name1, m, y, 2);
  y += 18;

  // Second line for long names
  if (c.productName.length > maxChars2) {
    const name2 = truncate(c.productName.substring(maxChars2), maxChars2);
    ctx.drawText(name2, m, y, 2);
    y += 16;
  }

  // Product description (free-form, 1 line truncated, scale 1)
  if (c.productDescription) {
    ctx.drawText(truncate(c.productDescription, maxChars1), m, y, 1);
    y += 10;
  }

  // Variant
  if (c.variant) {
    ctx.drawText(truncate(c.variant, maxChars1), m, y, 1);
    y += 10;
  }

  // SKU
  if (c.sku) {
    ctx.drawText(truncate('REF: ' + c.sku, maxChars1), m, y, 1);
    y += 10;
  }

  // Separator before customer section
  y += 2;
  ctx.hLine(m, y, textW, 1);
  y += 4;

  // Customer info (scale 2 for social handle + name for readability)
  if (c.socialHandle) {
    ctx.drawTextBold(truncate(c.socialHandle, maxChars2), m, y, 2);
    y += 18;
  }
  if (c.customerName) {
    ctx.drawTextBold(truncate(c.customerName, maxChars2), m, y, 2);
    y += 18;
  }

  if (c.country) {
    ctx.drawText(c.country, m, y, 1);
    y += 10;
  }

  // Bottom section: price
  const bottomY = h - m;

  // Price line (bold, scale 2, right-aligned with strikethrough just left of it)
  if (c.price) {
    const priceY = bottomY - 16;
    const priceW = c.price.length * 12; // scale 2 = 12px per char
    const priceX = m + textW - priceW;
    ctx.drawTextBold(c.price, priceX, priceY, 2);

    // Strikethrough original price just left of the real price
    if (c.originalPrice && c.originalPrice !== c.price) {
      const origW = c.originalPrice.length * 6 + 6;
      ctx.drawTextStrikethrough(c.originalPrice, priceX - origW, priceY + 4, 1);
    }

    // Quantity fraction at left
    if (c.quantityFraction) {
      ctx.drawTextRight(c.quantityFraction, m + textW, priceY + 4, 1);
    }
  }
}

/**
 * Large labels (h ≥ 80mm): full layout with large QR code, barcode, website.
 * Two-column layout with QR on the upper-right.
 */
function renderLargeLabel(ctx: BitmapCanvas, c: LabelContent, w: number, h: number): void {
  const m = 12;

  // QR column on right
  const qrModuleSize = 4;
  let qrSize = 0;
  let textW = w - m * 2;

  if (c.qrCodeUrl) {
    qrSize = BitmapCanvas.qrCodeSize(c.qrCodeUrl, qrModuleSize);
    const qrColW = qrSize + 10;
    textW = w - m - qrColW - 4;
    const qrX = w - m - qrSize;
    ctx.drawQrCode(c.qrCodeUrl, qrX, m, qrModuleSize);
  }

  const maxChars2 = Math.floor(textW / 12);
  const maxChars3 = Math.floor(textW / 18);
  const maxChars1 = Math.floor(textW / 6);
  let y = m;

  // Brand name (bold, scale 2)
  if (c.brandName) {
    ctx.drawTextBold(c.brandName.toUpperCase(), m, y, 2);
    y += 22;
    ctx.hLine(m, y, textW, 2);
    y += 6;
  }

  // Order info
  if (c.orderId) {
    let orderLine = c.orderId;
    if (c.orderDate) orderLine += '   ' + c.orderDate;
    ctx.drawText(truncate(orderLine, maxChars1), m, y, 1);
    y += 12;
  }

  // Separator
  ctx.hLine(m, y, textW, 1);
  y += 6;

  // Product name (bold, scale 3)
  const name1 = truncate(c.productName, maxChars3);
  ctx.drawTextBold(name1, m, y, 3);
  y += 26;

  if (c.productName.length > maxChars3) {
    const name2 = truncate(c.productName.substring(maxChars3), maxChars3);
    ctx.drawText(name2, m, y, 3);
    y += 24;
  }

  y += 4;

  // Product description (free-form, 1 line truncated, scale 2)
  if (c.productDescription) {
    ctx.drawText(truncate(c.productDescription, maxChars2), m, y, 2);
    y += 18;
  }

  // Variant (scale 2)
  if (c.variant) {
    ctx.drawText(truncate(c.variant, maxChars2), m, y, 2);
    y += 18;
  }

  // SKU
  if (c.sku) {
    ctx.drawText(truncate('REF: ' + c.sku, maxChars1), m, y, 1);
    y += 12;
  }

  // Separator
  ctx.hLine(m, y, textW, 1);
  y += 6;

  // Customer section (scale 2 for handle + name for live sales readability)
  if (c.socialHandle) {
    ctx.drawTextBold(truncate(c.socialHandle, maxChars2), m, y, 2);
    y += 18;
  }
  if (c.customerName) {
    ctx.drawTextBold(truncate(c.customerName, maxChars2), m, y, 2);
    y += 18;
  }
  if (c.country) {
    ctx.drawText(c.country, m, y, 1);
    y += 12;
  }

  // Quantity fraction
  if (c.quantityFraction) {
    y += 2;
    ctx.drawText(c.quantityFraction, m, y, 1);
    y += 12;
  }

  // ═══════════════════════════════════════════════════════
  // Bottom section (full width) — price, barcode, website
  // ═══════════════════════════════════════════════════════

  const fullW = w - m * 2;

  // Price section (centered, large)
  if (c.price) {
    y += 4;
    ctx.hLine(m, y, fullW, 1);
    y += 8;

    if (c.originalPrice && c.originalPrice !== c.price) {
      // Strikethrough original price centered
      const origW = c.originalPrice.length * 6;
      const origX = Math.floor((w - origW) / 2);
      ctx.drawTextStrikethrough(c.originalPrice, origX, y, 1);
      y += 12;
    }

    // Main price (bold, scale 4, centered)
    const priceScale = h > 600 ? 4 : 3;
    const priceWidth = c.price.length * 6 * priceScale;
    const priceX = Math.floor((w - priceWidth) / 2);
    ctx.drawTextBold(c.price, priceX, y, priceScale);
    y += 7 * priceScale + 8;
  }

  // Barcode at bottom
  if (c.barcode && y + 60 < h) {
    ctx.hLine(m, y, fullW, 1);
    y += 6;
    const moduleW = 2;
    const barcodePixels = encodeCode128B(c.barcode);
    const barcodeWidth = barcodePixels.length * moduleW;
    const barcodeX = Math.floor((w - barcodeWidth) / 2);
    ctx.drawBarcode(c.barcode, barcodeX, y, 36, moduleW);
    y += 40;
    const textWidth = c.barcode.length * 6;
    const textX = Math.floor((w - textWidth) / 2);
    ctx.drawText(c.barcode, textX, y, 1);
    y += 12;
  }

  // Website URL (very bottom, centered)
  if (c.websiteUrl) {
    const urlY = h - m - 8;
    const urlW = c.websiteUrl.length * 6;
    const urlX = Math.floor((w - urlW) / 2);
    ctx.drawText(c.websiteUrl, urlX, urlY, 1);
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
  0x3b: [0x00,0x00,0x04,0x00,0x04,0x04,0x08],
  0x3c: [0x00,0x02,0x04,0x08,0x04,0x02,0x00],
  0x3d: [0x00,0x00,0x1f,0x00,0x1f,0x00,0x00],
  0x3e: [0x00,0x08,0x04,0x02,0x04,0x08,0x00],
  0x3f: [0x0e,0x11,0x01,0x02,0x04,0x00,0x04],
  0x40: [0x0e,0x11,0x17,0x15,0x17,0x10,0x0e],
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
  0x5b: [0x0e,0x08,0x08,0x08,0x08,0x08,0x0e],
  0x5c: [0x10,0x08,0x04,0x04,0x02,0x01,0x00],
  0x5d: [0x0e,0x02,0x02,0x02,0x02,0x02,0x0e],
  0x5e: [0x04,0x0a,0x11,0x00,0x00,0x00,0x00],
  0x5f: [0x00,0x00,0x00,0x00,0x00,0x00,0x1f],
  0x26: [0x08,0x14,0x08,0x15,0x12,0x12,0x0d],
  0x2a: [0x04,0x15,0x0e,0x1f,0x0e,0x15,0x04],
  0x7b: [0x02,0x04,0x04,0x08,0x04,0x04,0x02],
  0x7c: [0x04,0x04,0x04,0x04,0x04,0x04,0x04],
  0x7d: [0x08,0x04,0x04,0x02,0x04,0x04,0x08],
  0x7e: [0x00,0x00,0x08,0x15,0x02,0x00,0x00],
  // Euro sign (€ = 0x20AC, mapped to a custom slot)
  0x80: [0x06,0x09,0x1e,0x08,0x1e,0x09,0x06],

  // ═══════════════════════════════════════════════════════
  // French accented characters (Unicode code points)
  // ═══════════════════════════════════════════════════════

  // Lowercase accented — accent on row 0, base letter rows 1-6
  // à (0xE0) — grave accent + a
  0xe0: [0x08,0x04,0x0e,0x01,0x0f,0x11,0x0f],
  // â (0xE2) — circumflex + a
  0xe2: [0x04,0x0a,0x0e,0x01,0x0f,0x11,0x0f],
  // ä (0xE4) — dieresis + a
  0xe4: [0x0a,0x00,0x0e,0x01,0x0f,0x11,0x0f],
  // è (0xE8) — grave + e
  0xe8: [0x08,0x04,0x0e,0x11,0x1f,0x10,0x0e],
  // é (0xE9) — acute + e
  0xe9: [0x02,0x04,0x0e,0x11,0x1f,0x10,0x0e],
  // ê (0xEA) — circumflex + e
  0xea: [0x04,0x0a,0x0e,0x11,0x1f,0x10,0x0e],
  // ë (0xEB) — dieresis + e
  0xeb: [0x0a,0x00,0x0e,0x11,0x1f,0x10,0x0e],
  // î (0xEE) — circumflex + i
  0xee: [0x04,0x0a,0x0c,0x04,0x04,0x04,0x0e],
  // ï (0xEF) — dieresis + i
  0xef: [0x0a,0x00,0x0c,0x04,0x04,0x04,0x0e],
  // ô (0xF4) — circumflex + o
  0xf4: [0x04,0x0a,0x0e,0x11,0x11,0x11,0x0e],
  // ù (0xF9) — grave + u
  0xf9: [0x08,0x04,0x11,0x11,0x11,0x13,0x0d],
  // û (0xFB) — circumflex + u
  0xfb: [0x04,0x0a,0x11,0x11,0x11,0x13,0x0d],
  // ü (0xFC) — dieresis + u
  0xfc: [0x0a,0x00,0x11,0x11,0x11,0x13,0x0d],
  // ç (0xE7) — c with cedilla
  0xe7: [0x00,0x00,0x0e,0x10,0x10,0x0e,0x04],

  // Uppercase accented — compressed: accent row 0, letter rows 1-6
  // À (0xC0)
  0xc0: [0x08,0x04,0x0e,0x11,0x1f,0x11,0x11],
  // Â (0xC2)
  0xc2: [0x04,0x0a,0x0e,0x11,0x1f,0x11,0x11],
  // È (0xC8)
  0xc8: [0x08,0x04,0x1f,0x10,0x1e,0x10,0x1f],
  // É (0xC9)
  0xc9: [0x02,0x04,0x1f,0x10,0x1e,0x10,0x1f],
  // Ê (0xCA)
  0xca: [0x04,0x0a,0x1f,0x10,0x1e,0x10,0x1f],
  // Ë (0xCB)
  0xcb: [0x0a,0x00,0x1f,0x10,0x1e,0x10,0x1f],
  // Î (0xCE)
  0xce: [0x04,0x0a,0x0e,0x04,0x04,0x04,0x0e],
  // Ï (0xCF)
  0xcf: [0x0a,0x00,0x0e,0x04,0x04,0x04,0x0e],
  // Ô (0xD4)
  0xd4: [0x04,0x0a,0x0e,0x11,0x11,0x11,0x0e],
  // Ù (0xD9)
  0xd9: [0x08,0x04,0x11,0x11,0x11,0x11,0x0e],
  // Û (0xDB)
  0xdb: [0x04,0x0a,0x11,0x11,0x11,0x11,0x0e],
  // Ü (0xDC)
  0xdc: [0x0a,0x00,0x11,0x11,0x11,0x11,0x0e],
  // Ç (0xC7)
  0xc7: [0x0e,0x11,0x10,0x10,0x11,0x0e,0x04],
};

// Map € to our custom slot
FONT_5X7[0x20ac] = FONT_5X7[0x80]!;
