/**
 * renderer.ts — WebGPU terminal renderer
 *
 * Renders terminal cells using WebGPU. Uses a simple quad-per-cell
 * approach with color from the terminal's render state.
 *
 * For text: renders colored background quads per cell. Full glyph
 * rendering requires a font atlas texture (future enhancement).
 */

import type { Terminal, RenderRow, CursorState, TerminalColors } from "./terminal.js";

interface RendererConfig {
  fontWidth: number;
  fontHeight: number;
  devicePixelRatio: number;
}

const DEFAULT_CONFIG: RendererConfig = {
  fontWidth: 8,
  fontHeight: 16,
  devicePixelRatio: window.devicePixelRatio || 1,
};

// WGSL shader for cell rendering
const CELL_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) pos: vec2f,
  @location(1) color: vec4f,
};

struct VertexOutput {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(in.pos, 0.0, 1.0);
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return in.color;
}
`;

// Cursor shader (blinking block/underline/bar)
const CURSOR_SHADER = /* wgsl */ `
struct VertexInput {
  @location(0) pos: vec2f,
  @location(1) color: vec4f,
  @location(2) cursorType: f32,  // 0=block, 1=underline, 2=bar
};

struct VertexOutput {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
  @location(1) cursorType: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.pos = vec4f(in.pos, 0.0, 1.0);
  out.color = in.color;
  out.cursorType = in.cursorType;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  return in.color;
}
`;

export class WebGPURenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private cellPipeline: GPURenderPipeline | null = null;
  private cursorPipeline: GPURenderPipeline | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private config: RendererConfig;
  private canvas: HTMLCanvasElement;

  // Buffers
  private cellVertexBuffer: GPUBuffer | null = null;
  private cellIndexBuffer: GPUBuffer | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Viewport
  private screenRows = 0;
  private screenCols = 0;

  constructor(canvas: HTMLCanvasElement, config?: Partial<RendererConfig>) {
    this.canvas = canvas;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) {
      console.warn("[renderer] WebGPU not available");
      return false;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "low-power",
      });
      if (!adapter) throw new Error("No adapter");

      this.device = await adapter.requestDevice({
        requiredFeatures: [],
        requiredLimits: {},
      });
      this.device.addEventListener("uncapturederror", (e) => {
        console.error("[renderer] WebGPU error:", e.error);
      });

      this.context = this.canvas.getContext("webgpu");
      if (!this.context) throw new Error("No WebGPU context");

      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: this.format,
        alphaMode: "opaque",
      });

      await this.createPipelines();
      await this.createBuffers();
      this.resizeCanvas();

      console.log("[renderer] WebGPU initialized");
      return true;
    } catch (err) {
      console.error("[renderer] WebGPU init failed:", err);
      return false;
    }
  }

  private async createPipelines(): Promise<void> {
    if (!this.device) return;

    const cellModule = this.device.createShaderModule({ code: CELL_SHADER });
    const cursorModule = this.device.createShaderModule({ code: CURSOR_SHADER });

    // Cell pipeline layout
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [],
    });

    // Cell pipeline: renders colored quads
    this.cellPipeline = this.device.createRenderPipeline({
      layout,
      vertex: {
        module: cellModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 24, // vec2f pos + vec4f color = 6 floats * 4 bytes
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: cellModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });

    // Cursor pipeline
    this.cursorPipeline = this.device.createRenderPipeline({
      layout,
      vertex: {
        module: cursorModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 32, // vec2 + vec4 + f32 = 8 floats * 4 bytes
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x4" },
            { shaderLocation: 2, offset: 24, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: cursorModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-strip" },
    });
  }

  private async createBuffers(): Promise<void> {
    if (!this.device) return;

    // Quad vertices: two triangles forming a rectangle
    // Vertex format: [x, y, r, g, b, a]
    const quadVerts = new Float32Array([
      // Triangle 1
      0, 0, 0, 0, 0, 0, // position (filled later), color (filled later)
      1, 0, 0, 0, 0, 0,
      0, 1, 0, 0, 0, 0,
      // Triangle 2
      1, 0, 0, 0, 0, 0,
      0, 1, 0, 0, 0, 0,
      1, 1, 0, 0, 0, 0,
    ]);

    this.cellVertexBuffer = this.device.createBuffer({
      size: quadVerts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cellVertexBuffer, 0, quadVerts);

    // Cursor instance data: 4 vertices for a triangle strip
    const cursorVerts = new Float32Array([
      -1, -1, 1, 1, 1, 1, 1, // top-left (ndc)
      1, -1, 1, 1, 1, 1, 1, // top-right
      -1, 1, 1, 1, 1, 1, 1, // bottom-left
      1, 1, 1, 1, 1, 1, 1, // bottom-right
    ]);
    const cursorVP = this.device.createBuffer({
      size: cursorVerts.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(cursorVP.getMappedRange()).set(cursorVerts);
    cursorVP.unmap();
  }

  private resizeCanvas(): void {
    const dpr = this.config.devicePixelRatio;
    const width = this.canvas.clientWidth * dpr;
    const height = this.canvas.clientHeight * dpr;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  setGrid(rows: number, cols: number): void {
    this.screenRows = rows;
    this.screenCols = cols;
  }

  getGridFromCanvas(): { rows: number; cols: number } {
    const dpr = this.config.devicePixelRatio;
    const width = Math.floor(this.canvas.clientWidth * dpr / this.config.fontWidth);
    const height = Math.floor(this.canvas.clientHeight * dpr / this.config.fontHeight);
    return { rows: Math.max(1, height), cols: Math.max(1, width) };
  }

  render(
    rows: RenderRow[],
    cursor: CursorState,
    colors: TerminalColors,
  ): void {
    if (!this.device || !this.context || !this.cellPipeline) return;

    this.resizeCanvas();

    const dpr = this.config.devicePixelRatio;
    const fw = this.config.fontWidth;
    const fh = this.config.fontHeight;
    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;

    // Build cell vertex data
    const maxCells = this.screenRows * this.screenCols * 6; // 6 verts per cell
    const vertData = new Float32Array(maxCells * 6); // 6 floats per vert
    let vertIdx = 0;

    for (const row of rows) {
      for (let col = 0; col < row.cells.length && col < this.screenCols; col++) {
        const cell = row.cells[col];
        const x = col * fw / canvasW * 2 - 1;
        const y = 1 - row.y * fh / canvasH * 2;
        const w = (fw * (cell.isWide ? 2 : 1)) / canvasW * 2;
        const h = fh / canvasH * 2;

        // Normalize colors to 0-1
        const r = cell.style.bg_r / 255;
        const g = cell.style.bg_g / 255;
        const b = cell.style.bg_b / 255;
        const a = 1.0;

        // If cell has a different FG, add a slight tint
        const fgR = cell.style.fg_r / 255;

        // 6 vertices per cell quad
        const verts = [
          x, y - h, r, g, b, a,
          x + w, y - h, r, g, b, a,
          x, y, r, g, b, a,
          x + w, y - h, r, g, b, a,
          x, y, r, g, b, a,
          x + w, y, r, g, b, a,
        ];

        for (let i = 0; i < verts.length && vertIdx < vertData.length; i++) {
          vertData[vertIdx++] = verts[i];
        }
      }
    }

    // Write vertex data to GPU
    if (vertIdx > 0) {
      const bufferSize = vertIdx * 4; // float32 = 4 bytes
      const vb = this.device.createBuffer({
        size: Math.max(bufferSize, 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vb, 0, vertData, 0, vertIdx);

      // Render
      const encoder = this.device.createCommandEncoder();
      const view = this.context.getCurrentTexture().createView();

      const bgColor = colors.background;
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          clearValue: {
            r: bgColor[0] / 255,
            g: bgColor[1] / 255,
            b: bgColor[2] / 255,
            a: bgColor[3] / 255,
          },
          loadOp: "clear",
          storeOp: "store",
        }],
      });

      pass.setPipeline(this.cellPipeline);
      pass.setVertexBuffer(0, vb);
      pass.draw(vertIdx / 6); // 6 floats per vertex, draw vertex count
      pass.end();

      this.device.queue.submit([encoder.finish()]);

      vb.destroy();
    }
  }

  destroy(): void {
    this.cellPipeline = null;
    this.cursorPipeline = null;
    this.cellVertexBuffer?.destroy();
    this.device?.destroy();
    this.device = null;
    this.context = null;
  }
}
