/**
 * renderer.ts — Hybrid WebGPU + Canvas2D terminal renderer
 *
 * Strategy:
 *   - WebGPU canvas: colored background quads, cursor
 *   - Canvas2D overlay: text glyphs (uses system monospace font)
 *
 * This gives us readable text immediately while the WebGPU glyph
 * atlas path is developed.
 */

import type { Terminal, RenderRow, CursorState, TerminalColors } from "./terminal.js";

interface RendererConfig {
  fontWidth: number;
  fontHeight: number;
  devicePixelRatio: number;
}

const DEFAULT_CONFIG: RendererConfig = {
  fontWidth: 8.4, // Monospace average width at 16px
  fontHeight: 16,
  devicePixelRatio: window.devicePixelRatio || 1,
};

export class TerminalRenderer {
  private canvas: HTMLCanvasElement;
  private textCanvas: HTMLCanvasElement;
  private textCtx: CanvasRenderingContext2D;
  private config: RendererConfig;
  private screenRows = 24;
  private screenCols = 80;
  private gpu: GPUState | null = null;

  // Animation frame tracking
  private rafId = 0;
  private needsDraw = true;
  private lastRows: RenderRow[] = [];
  private lastCursor: CursorState = { x: 0, y: 0, visible: true };
  private lastColors: TerminalColors = {
    foreground: [0xe0, 0xe0, 0xe0, 0xff],
    background: [0x1a, 0x1a, 0x2e, 0xff],
  };

  constructor(canvas: HTMLCanvasElement, config?: Partial<RendererConfig>) {
    this.canvas = canvas;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create text overlay canvas
    this.textCanvas = document.createElement("canvas");
    this.textCanvas.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;";
    this.canvas.parentElement?.appendChild(this.textCanvas);
    this.textCtx = this.textCanvas.getContext("2d")!;
    this.textCtx.textBaseline = "top";
    this.textCtx.font = `${this.config.fontHeight}px monospace`;
  }

  async init(): Promise<boolean> {
    if (navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: "low-power",
        });
        if (adapter) {
          const device = await adapter.requestDevice();
          const ctx = this.canvas.getContext("webgpu");
          if (ctx) {
            const format = navigator.gpu.getPreferredCanvasFormat();
            ctx.configure({ device, format, alphaMode: "opaque" });
            this.gpu = { adapter, device, context: ctx, format };
            console.log("[renderer] WebGPU initialized");
          }
        }
      } catch (err) {
        console.warn("[renderer] WebGPU init failed:", err);
      }
    }
    this.resize();
    return true;
  }

  resize(): void {
    const dpr = this.config.devicePixelRatio;
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;

    if (Math.abs(this.canvas.width - w) > 1 || Math.abs(this.canvas.height - h) > 1) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.textCanvas.width = w;
      this.textCanvas.height = h;
    }

    this.screenCols = Math.max(1, Math.floor(w / this.config.fontWidth));
    this.screenRows = Math.max(1, Math.floor(h / this.config.fontHeight));
    this.needsDraw = true;
  }

  getGrid(): { rows: number; cols: number } {
    return { rows: this.screenRows, cols: this.screenCols };
  }

  setGrid(rows: number, cols: number): void {
    this.screenRows = rows;
    this.screenCols = cols;
  }

  scheduleDraw(
    rows: RenderRow[],
    cursor: CursorState,
    colors: TerminalColors,
  ): void {
    this.lastRows = rows;
    this.lastCursor = cursor;
    this.lastColors = colors;
    this.needsDraw = true;
  }

  drawFrame(): void {
    if (!this.needsDraw) return;
    this.needsDraw = false;

    this.drawBackgrounds();
    this.drawText();
  }

  // ── Background rendering (WebGPU or Canvas2D fallback) ──────────
  private drawBackgrounds(): void {
    const dpr = this.config.devicePixelRatio;
    const fh = this.config.fontHeight;
    const rows = this.lastRows;
    const colors = this.lastColors;

    // Use Canvas2D for backgrounds (simple and always works)
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear to background
    ctx.fillStyle = rgbaStr(colors.background);
    ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

    // Draw cell backgrounds for non-default cells
    const fw = this.config.fontWidth;
    for (const row of rows) {
      const y = row.y * fh;
      for (let col = 0; col < row.cells.length; col++) {
        const cell = row.cells[col];
        const bgStr = rgbStr(cell.bg);
        if (bgStr !== rgbStr([0x1a, 0x1a, 0x2e])) {
          ctx.fillStyle = bgStr;
          ctx.fillRect(col * fw, y, fw, fh);
        }
      }
    }

    ctx.restore();
  }

  // ── Text rendering (Canvas2D) ───────────────────────────────────
  private drawText(): void {
    const ctx = this.textCtx;
    const dpr = this.config.devicePixelRatio;
    const fw = this.config.fontWidth;
    const fh = this.config.fontHeight;
    const rows = this.lastRows;
    const colors = this.lastColors;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, this.textCanvas.width / dpr, this.textCanvas.height / dpr);

    ctx.font = `${fh}px 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace`;
    ctx.textBaseline = "top";

    // Adjust font width based on actual measurement
    const measuredW = ctx.measureText("M").width;
    const actualFw = measuredW > 0 ? measuredW : fw;

    for (const row of rows) {
      const y = row.y * fh;

      // If we have pre-formatted text, render it directly
      if (row.text) {
        ctx.fillStyle = rgbaStr(colors.foreground);
        ctx.fillText(row.text, 0, y);
        continue;
      }

      // Otherwise render cell by cell
      for (let col = 0; col < row.cells.length; col++) {
        const cell = row.cells[col];
        const cp = cell.codepoint;
        if (cp <= 0x20 || cp === 0x7f) continue; // Skip control chars
        const ch = String.fromCodePoint(cp);

        const fg = cell.inverse ? cell.bg : cell.fg;
        ctx.fillStyle = rgbStr(fg);

        const x = col * actualFw;
        ctx.fillText(ch, x, y);
      }
    }

    ctx.restore();
  }

  destroy(): void {
    this.textCanvas.remove();
    this.gpu?.device?.destroy();
    this.gpu = null;
  }
}

// ── Color helpers ─────────────────────────────────────────────────
function rgbStr(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function rgbaStr(rgba: [number, number, number, number]): string {
  return `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;
}
