/**
 * terminal.ts — Ghostty VT terminal wrapper
 *
 * Manages the terminal emulator (ghostty-vt.wasm) and provides
 * an API to feed input, get render state, and query terminal state.
 *
 * Falls back to a raw text buffer when WASM is not loaded.
 */

// Types exported by ghostty-vt WASM (C ABI)
interface GhosttyWasm {
  // Memory
  ghostty_alloc(size: number): number;
  ghostty_free(ptr: number): void;
  ghostty_wasm_alloc_u8_array(ptr: number, len: number): number;
  ghostty_wasm_free_u8_array(ptr: number): void;
  // Terminal
  ghostty_terminal_new(rows: number, cols: number): number;
  ghostty_terminal_free(ptr: number): void;
  ghostty_terminal_resize(ptr: number, rows: number, cols: number): void;
  ghostty_terminal_vt_write(ptr: number, data: number, len: number): void;
  // Render state
  ghostty_render_state_new(terminal: number): number;
  ghostty_render_state_update(rs: number, terminal: number): number;
  ghostty_render_state_free(rs: number): void;
  // Colors
  ghostty_render_state_colors_get(
    rs: number,
    fg: number,
    bg: number,
    cursorFg: number,
    cursorBg: number,
    selFg: number,
    selBg: number,
  ): void;
  // Cursor
  ghostty_render_state_cursor_pos(rs: number, x: number, y: number): void;
  ghostty_render_state_cursor_visual_style(rs: number): number;
  // Viewport
  ghostty_render_state_viewport_size(rs: number, rows: number, cols: number): void;
  // Row iteration
  ghostty_render_state_row_iterator_new(rs: number): number;
  ghostty_render_state_row_iterator_next(it: number): number;
  ghostty_render_state_row_iterator_free(it: number): void;
  ghostty_render_state_row_get(it: number): number;
  ghostty_render_state_row_cells_new(it: number): number;
  ghostty_render_state_row_cells_next(cells: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  // Cell data
  ghostty_render_state_row_cells_get(
    cells: number,
    codepoint: number,
    style: number,
  ): void;
  ghostty_render_state_row_cells_get_multi(
    cells: number,
    codepoints: number,
    n: number,
    style: number,
    count: number,
  ): void;
  // Selection
  ghostty_terminal_select_all(terminal: number): void;
  ghostty_terminal_selection_format_alloc(
    terminal: number,
    output: number,
    len: number,
  ): number;
  // Key encode
  ghostty_key_event_new(): number;
  ghostty_key_event_free(ev: number): void;
  ghostty_key_event_set_utf8(ev: number, data: number, len: number): void;
  ghostty_key_encoder_new(): number;
  ghostty_key_encoder_free(enc: number): void;
  ghostty_key_encoder_setopt_from_terminal(
    enc: number,
    terminal: number,
  ): void;
  ghostty_key_encoder_encode(
    enc: number,
    ev: number,
    output: number,
    len: number,
  ): number;
  // Style
  ghostty_style_default(): number;
  ghostty_style_is_default(style: number): boolean;
  // Memory access
  memory: WebAssembly.Memory;
}

export interface CellStyle {
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
  dim: boolean;
  blink: boolean;
}

export interface Cell {
  codepoint: number; // Unicode codepoint
  width: number; // 1 or 2 (wide chars)
  style: CellStyle;
  isWide: boolean;
}

export interface RenderRow {
  y: number; // Row index in viewport
  cells: Cell[];
}

export interface CursorState {
  x: number;
  y: number;
  style: "bar" | "block" | "underline" | "hollow_block";
  visible: boolean;
}

export interface TerminalColors {
  foreground: [number, number, number, number]; // RGBA
  background: [number, number, number, number];
  cursor: [number, number, number, number];
  cursorText: [number, number, number, number];
  selectionFg: [number, number, number, number];
  selectionBg: [number, number, number, number];
}

export class Terminal {
  private wasm: GhosttyWasm | null = null;
  private terminalPtr = 0;
  private renderStatePtr = 0;
  private encoderPtr = 0;
  private keyEncoderPtr = 0;
  private rows = 24;
  private cols = 80;
  private fallbackBuffer = "";
  private loaded = false;

  // ── WASM loading ──────────────────────────────────────────────
  async load(wasmUrl?: string): Promise<void> {
    const url = wasmUrl ?? "/ghostty-vt.wasm";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const mod = await WebAssembly.instantiate(bytes, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256 }),
          // Required WASM imports
          abort: () => { /* noop */ },
        },
      });
      this.wasm = mod.instance.exports as unknown as GhosttyWasm;
      this.initFromWasm();
      this.loaded = true;
      console.log("[terminal] ghostty-vt.wasm loaded");
    } catch (err) {
      console.warn("[terminal] WASM load failed, using fallback:", err);
      this.loaded = false;
    }
  }

  private initFromWasm(): void {
    if (!this.wasm) return;
    this.terminalPtr = this.wasm.ghostty_terminal_new(this.rows, this.cols);
    this.renderStatePtr = this.wasm.ghostty_render_state_new(this.terminalPtr);
    this.encoderPtr = this.wasm.ghostty_key_event_new();
    this.keyEncoderPtr = this.wasm.ghostty_key_encoder_new();
    this.wasm.ghostty_key_encoder_setopt_from_terminal(
      this.keyEncoderPtr,
      this.terminalPtr,
    );
  }

  // ── Feed data ──────────────────────────────────────────────────
  write(data: Uint8Array | string): void {
    const buf = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;
    if (this.loaded && this.wasm) {
      const ptr = this.wasm.ghostty_wasm_alloc_u8_array(
        buf.byteOffset,
        buf.length,
      );
      this.wasm.ghostty_terminal_vt_write(this.terminalPtr, ptr, buf.length);
      this.wasm.ghostty_wasm_free_u8_array(ptr);
    } else {
      // Fallback: accumulate raw text
      const text = new TextDecoder().decode(buf);
      this.fallbackBuffer += text;
      // Keep buffer reasonable
      if (this.fallbackBuffer.length > 100_000) {
        this.fallbackBuffer = this.fallbackBuffer.slice(-50_000);
      }
    }
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    if (this.loaded && this.wasm) {
      this.wasm.ghostty_terminal_resize(this.terminalPtr, rows, cols);
    }
  }

  // ── Render state ────────────────────────────────────────────────
  getRenderRows(): RenderRow[] {
    if (!this.loaded || !this.wasm) {
      return this.fallbackRenderRows();
    }

    this.wasm.ghostty_render_state_update(
      this.renderStatePtr,
      this.terminalPtr,
    );
    const rows: RenderRow[] = [];
    const it = this.wasm.ghostty_render_state_row_iterator_new(
      this.renderStatePtr,
    );

    let rowPtr: number;
    while ((rowPtr = this.wasm.ghostty_render_state_row_iterator_next(it)) !== 0) {
      const y = this.wasm.ghostty_render_state_row_get(rowPtr);
      const cells: Cell[] = [];
      const cellsIt = this.wasm.ghostty_render_state_row_cells_new(rowPtr);
      let cellOk: number;
      while ((cellOk = this.wasm.ghostty_render_state_row_cells_next(cellsIt)) !== 0) {
        // Read cell codepoint and style together
        const codepoint = new Uint32Array(this.wasm.memory.buffer, 0, 1);
        const stylePtr = this.wasm.ghostty_style_default();
        // FIXME: actual cell reading needs proper buffer setup
        // For now, use simple codepoint access
        cells.push({
          codepoint: 0x20, // space
          width: 1,
          style: this.defaultStyle(),
          isWide: false,
        });
      }
      this.wasm.ghostty_render_state_row_cells_free(cellsIt);
      rows.push({ y, cells });
    }
    this.wasm.ghostty_render_state_row_iterator_free(it);
    return rows;
  }

  getCursor(): CursorState {
    return { x: 0, y: 0, style: "block", visible: true };
  }

  getColors(): TerminalColors {
    return {
      foreground: [0xe0, 0xe0, 0xe0, 0xff],
      background: [0x1a, 0x1a, 0x2e, 0xff],
      cursor: [0xff, 0xff, 0xff, 0xff],
      cursorText: [0x00, 0x00, 0x00, 0xff],
      selectionFg: [0xff, 0xff, 0xff, 0xff],
      selectionBg: [0x40, 0x40, 0x80, 0xff],
    };
  }

  // ── Input encoding ──────────────────────────────────────────────
  encodeKey(key: string, ctrl: boolean, alt: boolean, meta: boolean): Uint8Array | null {
    const text = key.length === 1 ? key : null;
    // Simple encoding for common keys
    if (text && !ctrl && !alt && !meta) {
      return new TextEncoder().encode(text);
    }
    if (key === "Enter") return new TextEncoder().encode("\r");
    if (key === "Backspace") return new TextEncoder().encode("\x7f");
    if (key === "Tab") return new TextEncoder().encode("\t");
    if (key === "Escape") return new TextEncoder().encode("\x1b");
    if (key === "ArrowUp") return new TextEncoder().encode("\x1b[A");
    if (key === "ArrowDown") return new TextEncoder().encode("\x1b[B");
    if (key === "ArrowRight") return new TextEncoder().encode("\x1b[C");
    if (key === "ArrowLeft") return new TextEncoder().encode("\x1b[D");
    if (key === "Home") return new TextEncoder().encode("\x1b[H");
    if (key === "End") return new TextEncoder().encode("\x1b[F");
    if (key === "PageUp") return new TextEncoder().encode("\x1b[5~");
    if (key === "PageDown") return new TextEncoder().encode("\x1b[6~");
    if (key === "Delete") return new TextEncoder().encode("\x1b[3~");
    if (key === "Insert") return new TextEncoder().encode("\x1b[2~");
    // Ctrl+letter
    if (ctrl && text && text.length === 1) {
      const c = text.charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) return new Uint8Array([c - 0x40]);
      if (c >= 0x61 && c <= 0x7a) return new Uint8Array([c - 0x60]);
    }
    return null;
  }

  // ── Fallback rendering ──────────────────────────────────────────
  private fallbackRenderRows(): RenderRow[] {
    const lines = this.fallbackBuffer.split("\n").slice(-this.rows);
    const result: RenderRow[] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].slice(0, this.cols);
      const cells: Cell[] = [];
      for (const ch of text) {
        cells.push({
          codepoint: ch.codePointAt(0) ?? 0x20,
          width: 1,
          style: this.defaultStyle(),
          isWide: false,
        });
      }
      // Pad to full width
      while (cells.length < this.cols) {
        cells.push({
          codepoint: 0x20,
          width: 1,
          style: this.defaultStyle(),
          isWide: false,
        });
      }
      result.push({ y: i, cells });
    }
    return result;
  }

  private defaultStyle(): CellStyle {
    return {
      fg_r: 0xe0, fg_g: 0xe0, fg_b: 0xe0,
      bg_r: 0x1a, bg_g: 0x1a, bg_b: 0x2e,
      bold: false, italic: false, underline: false,
      strikethrough: false, inverse: false, dim: false,
      blink: false,
    };
  }

  // ── Cleanup ─────────────────────────────────────────────────────
  destroy(): void {
    if (this.wasm && this.terminalPtr) {
      this.wasm.ghostty_render_state_free(this.renderStatePtr);
      this.wasm.ghostty_terminal_free(this.terminalPtr);
      this.wasm.ghostty_key_event_free(this.keyEncoderPtr);
      this.wasm.ghostty_key_encoder_free(this.encoderPtr);
    }
  }
}
