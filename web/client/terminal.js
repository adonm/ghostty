/**
 * terminal.ts — Ghostty VT terminal wrapper (WASM)
 *
 * Loads ghostty-vt.wasm and provides a simple API for:
 *   - Creating terminals
 *   - Writing VT data
 *   - Getting screen content (via formatter)
 *   - Encoding keyboard input
 */

// ── C type constants (from ghostty/vt/types.h) ────────────────────
const GHOSTTY_RESULT = { SUCCESS: 0, OUT_OF_MEMORY: 1, INVALID_VALUE: 2 };
const GHOSTTY_ALLOCATOR = { SIZE: 24 }; // GhosttyAllocator struct size

interface GhosttyVtExports {
  memory: WebAssembly.Memory;

  // Terminal
  ghostty_terminal_new(alloc: number): number;
  ghostty_terminal_free(t: number): void;
  ghostty_terminal_vt_write(t: number, data: number, len: number): void;
  ghostty_terminal_resize(t: number, rows: number, cols: number): void;

  // Render state
  ghostty_render_state_new(alloc: number, out: number): number;
  ghostty_render_state_update(rs: number, t: number): number;
  ghostty_render_state_free(rs: number): void;
  ghostty_render_state_get(rs: number, kind: number, out: number): number;

  // Formatter
  ghostty_formatter_terminal_new(
    alloc: number, t: number, out: number,
  ): number;
  ghostty_formatter_free(f: number): number;
  ghostty_formatter_format_alloc(
    f: number, style: number, out_ptr: number, out_len: number,
  ): number;

  // Render state rows
  ghostty_render_state_row_iterator_new(alloc: number, out: number): number;
  ghostty_render_state_row_iterator_free(it: number): void;
  ghostty_render_state_row_set(rs: number, kind: number, val: number): number;
  ghostty_render_state_row_get(it: number, out: number): number;

  // Grid ref
  ghostty_terminal_grid_ref(t: number, point: number, out: number): number;

  // Allocator
  ghostty_alloc(size: number): number;
  ghostty_free(ptr: number): void;
  ghostty_wasm_alloc_u8_array(ptr: number, len: number): number;
  ghostty_wasm_free_u8_array(ptr: number): void;

  // Key
  ghostty_key_event_new(): number;
  ghostty_key_event_free(ev: number): void;
  ghostty_key_event_set_utf8(ev: number, ptr: number, len: number): void;
  ghostty_key_encoder_new(): number;
  ghostty_key_encoder_free(enc: number): void;
  ghostty_key_encoder_setopt_from_terminal(enc: number, t: number): number;
  ghostty_key_encoder_encode(
    enc: number, ev: number, out_ptr: number, out_len: number,
  ): number;

  // Selection format
  ghostty_terminal_selection_format_alloc(
    t: number, style: number, out_ptr: number, out_len: number,
  ): number;

  // Mouse
  ghostty_mouse_event_new(): number;
  ghostty_mouse_event_free(ev: number): void;
  ghostty_mouse_event_set_button(ev: number, btn: number): void;
  ghostty_mouse_event_set_mods(ev: number, mods: number): void;
  ghostty_mouse_event_set_position(ev: number, x: number, y: number): void;
  ghostty_mouse_encoder_new(): number;
  ghostty_mouse_encoder_free(enc: number): void;
  ghostty_mouse_encoder_setopt_from_terminal(enc: number, t: number): number;
  ghostty_mouse_encoder_encode(
    enc: number, ev: number, out_ptr: number, out_len: number,
  ): number;
}

export interface Cell {
  codepoint: number;
  width: number;
  fg: [number, number, number];
  bg: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

export interface RenderRow {
  y: number;
  text: string; // For now: plain text per row
  cells: Cell[];
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
}

export interface TerminalColors {
  foreground: [number, number, number, number];
  background: [number, number, number, number];
}

export class Terminal {
  private wasm: GhosttyVtExports | null = null;
  private mem: DataView | null = null;
  private tPtr = 0;
  private rsPtr = 0;
  private fmtPtr = 0;
  private keyEncPtr = 0;
  private keyEvPtr = 0;
  private rows = 24;
  private cols = 80;
  private loaded = false;
  private textBuffer = "";
  private initialized = false;

  async load(wasmUrl?: string): Promise<void> {
    const url = wasmUrl ?? "/ghostty-vt.wasm";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const env = {
        memory: new WebAssembly.Memory({ initial: 256, maximum: 1024 }),
        // WASI stubs (ghostty-vt doesn't use WASI but the toolchain may emit imports)
        "wasi_snapshot_preview1": {
          fd_write: () => { /* noop */ },
          fd_close: () => { /* noop */ },
          fd_seek: () => { /* noop */ },
          proc_exit: () => { /* noop */ },
          environ_sizes_get: () => 0,
          environ_get: () => 0,
        },
      };
      const mod = await WebAssembly.instantiate(bytes, { env });
      this.wasm = mod.instance.exports as unknown as GhosttyVtExports;
      this.mem = new DataView(this.wasm.memory.buffer);
      this.loaded = true;
      console.log("[terminal] ghostty-vt.wasm loaded successfully");
      this.init();
    } catch (err) {
      console.warn("[terminal] WASM load failed, using text fallback:", err);
      this.loaded = false;
    }
  }

  private init(): void {
    if (!this.loaded || !this.wasm) return;

    // Create terminal
    this.tPtr = this.wasm.ghostty_terminal_new(0); // NULL allocator = default
    if (!this.tPtr) {
      console.error("[terminal] failed to create terminal");
      this.loaded = false;
      return;
    }

    // Create render state
    const rsBuf = new Uint32Array(1);
    this.wasm.ghostty_render_state_new(0, this.ptrOf(rsBuf));
    this.rsPtr = rsBuf[0];
    if (!this.rsPtr) {
      console.warn("[terminal] render state creation failed");
    }

    // Create formatter
    const fmtBuf = new Uint32Array(1);
    this.wasm.ghostty_formatter_terminal_new(0, this.tPtr, this.ptrOf(fmtBuf));
    this.fmtPtr = fmtBuf[0];

    // Create key encoder + event
    this.keyEvPtr = this.wasm.ghostty_key_event_new();
    this.keyEncPtr = this.wasm.ghostty_key_encoder_new();
    this.wasm.ghostty_key_encoder_setopt_from_terminal(
      this.keyEncPtr, this.tPtr,
    );

    // Resize to initial dimensions
    this.wasm.ghostty_terminal_resize(this.tPtr, this.rows, this.cols);

    this.initialized = true;
  }

  // ── Helpers ────────────────────────────────────────────────────
  private ptrOf(arr: Uint8Array | Uint32Array): number {
    return arr.byteOffset;
  }

  private readString(ptr: number, len: number): string {
    if (!this.mem || len <= 0) return "";
    const bytes = new Uint8Array(this.mem.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
  }

  private allocStr(s: string): { ptr: number; len: number } {
    if (!this.wasm) return { ptr: 0, len: 0 };
    const enc = new TextEncoder();
    const buf = enc.encode(s);
    const ptr = this.wasm.ghostty_wasm_alloc_u8_array(
      this.ptrOf(buf), buf.length,
    );
    return { ptr, len: buf.length };
  }

  // ── Public API ─────────────────────────────────────────────────
  write(data: Uint8Array | string): void {
    const buf = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data;

    if (this.loaded && this.wasm && this.initialized) {
      const { ptr, len } = this.allocBinary(buf);
      this.wasm.ghostty_terminal_vt_write(this.tPtr, ptr, len);
      this.wasm.ghostty_wasm_free_u8_array(ptr);
    } else {
      // Fallback text buffer
      this.textBuffer += new TextDecoder().decode(buf);
      const lines = this.textBuffer.split("\n");
      if (lines.length > this.rows * 2) {
        this.textBuffer = lines.slice(-this.rows).join("\n");
      }
    }
  }

  private allocBinary(buf: Uint8Array): { ptr: number; len: number } {
    if (!this.wasm) return { ptr: 0, len: 0 };
    const ptr = this.wasm.ghostty_wasm_alloc_u8_array(
      this.ptrOf(buf), buf.length,
    );
    return { ptr, len: buf.length };
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    if (this.loaded && this.wasm && this.initialized) {
      this.wasm.ghostty_terminal_resize(this.tPtr, rows, cols);
    }
  }

  getRenderRows(): RenderRow[] {
    if (!this.loaded || !this.wasm || !this.initialized) {
      return this.fallbackRows();
    }
    return this.wasmRows();
  }

  // ── WASM render ────────────────────────────────────────────────
  private wasmRows(): RenderRow[] {
    if (!this.wasm || !this.mem) return this.fallbackRows();

    // Method 1: format screen as plain text
    // const text = this.formatScreen();
    // return textToRenderRows(text, this.rows, this.cols);

    // Method 2: render state iteration (simpler row counts)
    const rows: RenderRow[] = [];

    // Get screen size from render state
    // For now, read the screen by iterating rows via grid_ref
    // This is simplified: just get the formatted text per row

    // Use render state to get screen content
    if (this.rsPtr) {
      this.wasm.ghostty_render_state_update(this.rsPtr, this.tPtr);

      // Create row iterator
      const itBuf = new Uint32Array(1);
      const result = this.wasm.ghostty_render_state_row_iterator_new(
        0, this.ptrOf(itBuf),
      );
      if (result !== 0) {
        return this.fallbackRows();
      }

      const it = itBuf[0];
      const rowOut = new Int32Array(1);

      for (let i = 0; i < this.rows; i++) {
        const rowRes = this.wasm.ghostty_render_state_row_get(
          it, this.ptrOf(rowOut),
        );
        if (rowRes !== 0 || rowOut[0] < 0) break;

        const y = rowOut[0];
        // For now, just mark rows as existing. Cell iteration
        // requires the cells_new/next/get API which is more complex.
        rows.push({ y, text: "", cells: [] });
      }

      this.wasm.ghostty_render_state_row_iterator_free(it);
    }

    // Fallback: format as plain text
    if (rows.length === 0) {
      return this.fallbackRows();
    }

    return rows;
  }

  // ── Format as plain text ───────────────────────────────────────
  private formatScreen(): string {
    if (!this.wasm || !this.fmtPtr) return this.textBuffer;

    const outPtr = new Uint32Array(1);
    const outLen = new Uint32Array(1);
    const result = this.wasm.ghostty_formatter_format_alloc(
      this.fmtPtr,
      0, // PLAIN_TEXT = 0
      this.ptrOf(outPtr),
      this.ptrOf(outLen),
    );
    if (result !== 0) return this.textBuffer;

    const text = this.readString(outPtr[0], Math.min(outLen[0], 100000));
    this.wasm.ghostty_free(outPtr[0]);
    return text;
  }

  getCursor(): CursorState {
    return { x: 0, y: 0, visible: true };
  }

  getColors(): TerminalColors {
    return {
      foreground: [0xe0, 0xe0, 0xe0, 0xff],
      background: [0x1a, 0x1a, 0x2e, 0xff],
    };
  }

  // ── Input encoding ──────────────────────────────────────────────
  encodeKey(
    key: string,
    ctrl: boolean,
    alt: boolean,
    meta: boolean,
  ): Uint8Array | null {
    const text = key.length === 1 ? key : null;

    // Simple common-case encoding
    if (text && !ctrl && !alt && !meta) return new TextEncoder().encode(text);
    if (key === "Enter") return new Uint8Array([13]); // \r
    if (key === "Backspace") return new Uint8Array([127]); // \x7f
    if (key === "Tab") return new Uint8Array([9]); // \t
    if (key === "Escape") return new Uint8Array([27]); // \x1b

    // Arrow keys (ANSI)
    if (key === "ArrowUp") return new Uint8Array([27, 91, 65]); // ESC [ A
    if (key === "ArrowDown") return new Uint8Array([27, 91, 66]); // ESC [ B
    if (key === "ArrowRight") return new Uint8Array([27, 91, 67]); // ESC [ C
    if (key === "ArrowLeft") return new Uint8Array([27, 91, 68]); // ESC [ D

    // Nav keys
    if (key === "Home") return new Uint8Array([27, 91, 72]); // ESC [ H
    if (key === "End") return new Uint8Array([27, 91, 70]); // ESC [ F
    if (key === "PageUp") return new Uint8Array([27, 91, 53, 126]); // ESC [ 5 ~
    if (key === "PageDown") return new Uint8Array([27, 91, 54, 126]); // ESC [ 6 ~
    if (key === "Delete") return new Uint8Array([27, 91, 51, 126]); // ESC [ 3 ~
    if (key === "Insert") return new Uint8Array([27, 91, 50, 126]); // ESC [ 2 ~

    // Ctrl+letter
    if (ctrl && text && text.length === 1) {
      const c = text.charCodeAt(0);
      if (c >= 0x40 && c <= 0x5f) return new Uint8Array([c - 0x40]);
      if (c >= 0x61 && c <= 0x7a) return new Uint8Array([c - 0x60]);
    }

    return null;
  }

  // ── Fallback: plain text rows ───────────────────────────────────
  private fallbackRows(): RenderRow[] {
    return textToRenderRows(this.formatScreen() || this.textBuffer, this.rows, this.cols);
  }

  destroy(): void {
    if (this.wasm) {
      if (this.fmtPtr) this.wasm.ghostty_formatter_free(this.fmtPtr);
      if (this.rsPtr) this.wasm.ghostty_render_state_free(this.rsPtr);
      if (this.tPtr) this.wasm.ghostty_terminal_free(this.tPtr);
      if (this.keyEvPtr) this.wasm.ghostty_key_event_free(this.keyEvPtr);
      if (this.keyEncPtr) this.wasm.ghostty_key_encoder_free(this.keyEncPtr);
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────
function textToRenderRows(
  text: string, maxRows: number, maxCols: number,
): RenderRow[] {
  const lines = text.split("\n").slice(-maxRows);
  const rows: RenderRow[] = [];
  for (let i = 0; i < Math.min(lines.length, maxRows); i++) {
    const line = lines[i].slice(0, maxCols);
    const cells: Cell[] = [];
    for (const ch of line) {
      cells.push({
        codepoint: ch.codePointAt(0) ?? 0x20,
        width: 1,
        fg: [0xe0, 0xe0, 0xe0],
        bg: [0x1a, 0x1a, 0x2e],
        bold: false,
        italic: false,
        underline: false,
        inverse: false,
      });
    }
    rows.push({ y: i, text: line, cells });
  }
  return rows;
}
