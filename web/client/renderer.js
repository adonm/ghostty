/**
 * renderer.ts — Canvas2D terminal renderer
 *
 * Renders ANSI-colored text on a Canvas2D surface.
 * Simple, always-works approach. WebGPU upgrade path remains open
 * for the future (font atlas textures, shader effects).
 */

import type { Cell } from "./ansi.js";
import { ansiColorToRgb } from "./ansi.js";

interface RendererConfig {
  fontWidth: number;
  fontHeight: number;
  devicePixelRatio: number;
}

const DEFAULT_CONFIG: RendererConfig = {
  fontWidth: 8.4,
  fontHeight: 16,
  devicePixelRatio: window.devicePixelRatio || 1,
};

export class TerminalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: RendererConfig;
  private screenRows = 24;
  private screenCols = 80;
  private rafId = 0;
  private needsDraw = true;

  private lastGrid: Cell[][] = [];
  private cursorX = 0;
  private cursorY = 0;
  private cursorVisible = true;
  private blinkPhase = 0;

  // Font measurement
  private charWidth: number;
  private charHeight: number;

  constructor(canvas: HTMLCanvasElement, config?: Partial<RendererConfig>) {
    this.canvas = canvas;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ctx = canvas.getContext("2d")!;
    this.charWidth = this.config.fontWidth;
    this.charHeight = this.config.fontHeight;
    this.setupFont();
  }

  async init(): Promise<boolean> {
    this.resize();
    return true;
  }

  private setupFont(): void {
    const size = this.config.fontHeight * this.config.devicePixelRatio;
    this.ctx.font = `${size}px 'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Liberation Mono', monospace`;
    this.ctx.textBaseline = "top";
    // Measure actual character width
    const m = this.ctx.measureText("M");
    this.charWidth = m.width / this.config.devicePixelRatio;
    this.charHeight = this.config.fontHeight;
  }

  resize(): void {
    const dpr = this.config.devicePixelRatio;
    const w = this.canvas.clientWidth * dpr;
    const h = this.canvas.clientHeight * dpr;

    if (Math.abs(this.canvas.width - w) > 1 || Math.abs(this.canvas.height - h) > 1) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.setupFont();
    }

    this.screenCols = Math.max(1, Math.floor(this.canvas.clientWidth / this.charWidth));
    this.screenRows = Math.max(1, Math.floor(this.canvas.clientHeight / this.charHeight));
    this.needsDraw = true;
  }

  getGrid(): { rows: number; cols: number } {
    return { rows: this.screenRows, cols: this.screenCols };
  }

  setGrid(rows: number, cols: number): void {
    this.screenRows = rows;
    this.screenCols = cols;
  }

  scheduleDraw(grid: Cell[][], cx: number, cy: number): void {
    this.lastGrid = grid;
    this.cursorX = cx;
    this.cursorY = cy;
    this.needsDraw = true;
  }

  drawFrame(): void {
    if (!this.needsDraw) return;
    this.needsDraw = false;

    const ctx = this.ctx;
    const dpr = this.config.devicePixelRatio;
    const cw = this.charWidth;
    const ch = this.charHeight;
    const grid = this.lastGrid;
    const rows = this.screenRows;
    const cols = this.screenCols;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear to background
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);

    // Draw cells
    for (let y = 0; y < Math.min(rows, grid.length); y++) {
      const row = grid[y];
      if (!row) continue;
      
      for (let x = 0; x < Math.min(cols, row.length); x++) {
        const cell = row[x];
        const char = cell.char;
        if (char === " " && cell.bg < 0) continue;

        const px = x * cw;
        const py = y * ch;

        // Background
        if (cell.bg >= 0) {
          const [r, g, b] = ansiColorToRgb(cell.bg);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(px, py, cw, ch);
        }

        // Text
        if (char !== " ") {
          const [r, g, b] = ansiColorToRgb(cell.fg);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          if (cell.bold) {
            ctx.font = `bold ${ch * dpr}px monospace`;
          } else {
            ctx.font = `${ch * dpr}px monospace`;
          }
          ctx.textBaseline = "top";
          ctx.fillText(char, px, py);

          // Underline
          if (cell.underline) {
            ctx.fillRect(px, py + ch - 2, cw, 1);
          }
        }
      }
    }

    // Draw cursor
    if (this.cursorVisible) {
      const cx = this.cursorX * cw;
      const cy = this.cursorY * ch;
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(cx, cy, cw, ch);
    }

    ctx.restore();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}
