/**
 * ansi.ts — Lightweight ANSI/VT parser
 *
 * Parses terminal escape sequences into a display grid.
 * Handles: cursor movement, SGR colors, erase operations, line feed.
 * Designed for the Canvas2D terminal renderer.
 */

export interface Cell {
  char: string;       // UTF-8 character
  fg: number;         // ANSI 256-color index or -1 for default
  bg: number;         // ANSI 256-color index or -1 for default
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  blink: boolean;
  strikethrough: boolean;
}

export interface KittyImage {
  id: number;
  imageNum: number;
  total: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  x: number;
  y: number;
  z: number;
  format: number;
  data: Uint8Array;
  placementId: number;
  quiet: boolean;
  bitmap?: ImageBitmap;
  loaded?: boolean;
}

const enum KittyState { Idle, InAPC, HaveData }

export class AnsiParser {
  cols: number;
  rows: number;
  grid: Cell[][];
  cursorX = 0;
  cursorY = 0;
  private savedX = 0;
  private savedY = 0;
  private state: ParserState = ParserState.Ground;
  private params: number[] = [];
  private paramStr = "";
  private oscStr = "";
  private oscTerminated = false;
  private defaultFg = 7;
  private defaultBg = 0;

  // Current SGR state
  private currentFg = -1;
  private currentBg = -1;
  private currentBold = false;
  private currentItalic = false;
  private currentUnderline = false;
  private currentInverse = false;
  private currentDim = false;
  private currentBlink = false;
  private currentStrikethrough = false;

  // Kitty graphics state
  private kittyState: KittyState = KittyState.Idle;
  private kittyChunk = "";
  private kittyFormat = 0;
  private kittyImageId = 0;
  private kittyImageNum = 0;
  private kittyImageTotal = 0;
  private kittyPayload = new Uint8Array(0);

  /** Callback when a Kitty graphics image is fully received. */
  onKittyImage: ((img: KittyImage) => void) | null = null;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.grid = this.createGrid();
  }

  private createGrid(): Cell[][] {
    const grid: Cell[][] = [];
    for (let y = 0; y < this.rows; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < this.cols; x++) {
        row.push(this.emptyCell());
      }
      grid.push(row);
    }
    return grid;
  }

  private emptyCell(): Cell {
    return {
      char: " ",
      fg: -1,
      bg: -1,
      bold: false,
      italic: false,
      underline: false,
      inverse: false,
      dim: false,
      blink: false,
      strikethrough: false,
    };
  }

  /** Feed raw bytes to the parser. */
  feed(data: Uint8Array): void {
    for (const byte of data) {
      this.processByte(byte);
    }
  }

  resize(cols: number, rows: number): void {
    const oldGrid = this.grid;
    this.cols = cols;
    this.rows = rows;
    this.grid = this.createGrid();
    
    // Preserve existing content where possible
    for (let y = 0; y < Math.min(rows, oldGrid.length); y++) {
      for (let x = 0; x < Math.min(cols, oldGrid[y]?.length ?? 0); x++) {
        this.grid[y][x] = oldGrid[y][x];
      }
    }
    
    if (this.cursorX >= cols) this.cursorX = cols - 1;
    if (this.cursorY >= rows) this.cursorY = rows - 1;
  }

  private processByte(b: number): void {
    switch (this.state) {
      case ParserState.Ground:
        this.ground(b);
        break;
      case ParserState.Escape:
        this.escape(b);
        break;
      case ParserState.CsiEntry:
        this.csiEntry(b);
        break;
      case ParserState.CsiParam:
        this.csiParam(b);
        break;
      case ParserState.CsiIntermediate:
        this.csiIntermediate(b);
        break;
      case ParserState.OscString:
        this.oscString(b);
        break;
      case ParserState.ApcString:
        this.apcString(b);
        break;
    }
  }

  private ground(b: number): void {
    if (b === 0x1b) {
      this.state = ParserState.Escape;
    } else if (b === 0x0d) {
      // CR: carriage return
      this.cursorX = 0;
    } else if (b === 0x0a || b === 0x0b || b === 0x0c) {
      // LF, VT, FF: line feed
      this.lineFeed();
    } else if (b === 0x08) {
      // BS: backspace
      if (this.cursorX > 0) this.cursorX--;
    } else if (b === 0x09) {
      // TAB
      this.cursorX = ((this.cursorX + 8) / 8 | 0) * 8;
      if (this.cursorX >= this.cols) this.cursorX = this.cols - 1;
    } else if (b >= 0x20 && b <= 0x7e) {
      // Printable ASCII
      this.putChar(String.fromCodePoint(b));
    } else if (b >= 0xc0) {
      // UTF-8 continuation — handled by TextDecoder at higher level
      // For raw byte streams, we'd need a UTF-8 decoder here
      this.putChar(String.fromCodePoint(b));
    }
  }

  private escape(b: number): void {
    if (b === 0x5b) {
      // ESC [
      this.state = ParserState.CsiEntry;
      this.params = [];
      this.paramStr = "";
    } else if (b === 0x5d) {
      // ESC ]
      this.state = ParserState.OscString;
      this.oscStr = "";
      this.oscTerminated = false;
    } else if (b === 0x37) {
      // ESC 7 — save cursor
      this.savedX = this.cursorX;
      this.savedY = this.cursorY;
      this.state = ParserState.Ground;
    } else if (b === 0x38) {
      // ESC 8 — restore cursor
      this.cursorX = this.savedX;
      this.cursorY = this.savedY;
      this.state = ParserState.Ground;
    } else if (b === 0x5f) {
      // ESC _ — APC (Kitty graphics protocol)
      this.state = ParserState.ApcString;
      this.kittyChunk = "";
      this.kittyState = KittyState.Idle;
    } else if (b === 0x44) {
      // ESC D — index (scroll down if at bottom)
      this.lineFeed();
      this.state = ParserState.Ground;
    } else if (b === 0x4d) {
      // ESC M — reverse index
      if (this.cursorY > 0) this.cursorY--;
      this.state = ParserState.Ground;
    } else if (b === 0x63) {
      // ESC c — reset
      this.reset();
      this.state = ParserState.Ground;
    } else {
      this.state = ParserState.Ground;
    }
  }

  private csiEntry(b: number): void {
    if (b >= 0x30 && b <= 0x39) {
      this.paramStr = String.fromCodePoint(b);
      this.state = ParserState.CsiParam;
    } else if (b === 0x3b) {
      this.params.push(0);
      this.state = ParserState.CsiParam;
    } else if (b === 0x3f) {
      // ? prefix (private CSI)
      this.state = ParserState.CsiParam;
    } else if (b >= 0x20 && b <= 0x2f) {
      this.state = ParserState.CsiIntermediate;
    } else {
      this.executeCsi(b);
      this.state = ParserState.Ground;
    }
  }

  private csiParam(b: number): void {
    if (b >= 0x30 && b <= 0x39) {
      this.paramStr += String.fromCodePoint(b);
    } else if (b === 0x3b) {
      const val = parseInt(this.paramStr, 10) || 0;
      this.params.push(val);
      this.paramStr = "";
    } else if (b >= 0x20 && b <= 0x2f) {
      const val = parseInt(this.paramStr, 10) || 0;
      this.params.push(val);
      this.paramStr = "";
      this.state = ParserState.CsiIntermediate;
    } else {
      const val = parseInt(this.paramStr, 10) || 0;
      this.params.push(val);
      this.paramStr = "";
      this.executeCsi(b);
      this.state = ParserState.Ground;
    }
  }

  private csiIntermediate(b: number): void {
    if (b >= 0x20 && b <= 0x2f) {
      // collect intermediate
    } else {
      this.executeCsi(b);
      this.state = ParserState.Ground;
    }
  }

  private oscString(b: number): void {
    if (b === 0x07 || (b === 0x1b)) {
      // BEL or ESC (start of ST)
      if (b === 0x1b) {
        this.oscTerminated = true;
        return;
      }
      this.state = ParserState.Ground;
    } else if (this.oscTerminated && b === 0x5c) {
      // ST terminator
      this.state = ParserState.Ground;
    } else if (b >= 0x20) {
      this.oscStr += String.fromCodePoint(b);
    }
  }

  // ── Kitty graphics protocol (APC) ────────────────────────────
  private apcString(b: number): void {
    if (b === 0x1b) {
      // ESC — possible ST start
      this.kittyState = KittyState.InAPC;
      return;
    }
    if (this.kittyState === KittyState.InAPC && b === 0x5c) {
      // ST (ESC \) — end of APC
      this.processKitty(this.kittyChunk);
      this.state = ParserState.Ground;
      this.kittyState = KittyState.Idle;
      return;
    }
    if (b === 0x07) {
      // BEL — alternative terminator
      this.processKitty(this.kittyChunk);
      this.state = ParserState.Ground;
      this.kittyState = KittyState.Idle;
      return;
    }
    this.kittyState = KittyState.HaveData;
    if (b >= 0x20 && b < 0x7f) {
      this.kittyChunk += String.fromCodePoint(b);
    }
  }

  private processKitty(chunk: string): void {
    // Parse key=value pairs separated by commas
    const parts = chunk.split(";");
    if (parts.length < 2) return;
    
    const params: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      params[part.slice(0, eq)] = part.slice(eq + 1);
    }

    const action = params["a"];
    if (!action) return;

    switch (action) {
      case "T": // transmit image data
      case "t": {
        const format = parseInt(params["f"] || "32");
        // f=100: PNG (chunked in multiple APC sequences)
        // f=24: direct PNG in single payload
        const isPNG = format === 100 || format === 24;
        if (!isPNG) return;

        const payload = params["s"] || "";
        const isBase64 = !params["o"] || params["o"] === "z";
        let data: Uint8Array;
        try {
          data = isBase64 
            ? Uint8Array.from(atob(payload), c => c.charCodeAt(0))
            : new TextEncoder().encode(payload);
        } catch { return; }
        if (data.length === 0) return;

        // Check if chunked
        const m = parseInt(params["m"] || "0");
        if (m > 0) {
          // Chunked: m=1 means more chunks follow, m=0 means last chunk
          const tmp = new Uint8Array(this.kittyPayload.length + data.length);
          tmp.set(this.kittyPayload);
          tmp.set(data, this.kittyPayload.length);
          this.kittyPayload = tmp;
          if (m === 0) {
            // Last chunk — process complete image
            this.emitKittyImage(params, this.kittyPayload, format);
            this.kittyPayload = new Uint8Array(0);
          }
        } else {
          // Single payload
          this.emitKittyImage(params, data, format);
        }
        break;
      }
      case "p": // query (ignore)
      case "q": // query response (ignore)
        break;
    }
  }

  private emitKittyImage(params: Record<string, string>, data: Uint8Array, format: number): void {
    if (!this.onKittyImage) return;

    const img: KittyImage = {
      id: parseInt(params["i"] || "0"),
      imageNum: parseInt(params["I"] || "0") || 1,
      total: parseInt(params["n"] || "0") || 1,
      width: parseInt(params["w"] || "0"),
      height: parseInt(params["h"] || "0"),
      cols: parseInt(params["c"] || "0"),
      rows: parseInt(params["r"] || "0"),
      x: parseInt(params["x"] || "0"),
      y: parseInt(params["y"] || "0"),
      z: parseInt(params["z"] || "0"),
      format,
      data,
      placementId: parseInt(params["p"] || "0"),
      quiet: params["q"] === "2",
    };

    this.onKittyImage(img);
  }

  private executeCsi(finalByte: number): void {
    const p = this.params;
    switch (finalByte) {
      case 0x41: // A — cursor up
        this.cursorY = Math.max(0, this.cursorY - (p[0] || 1));
        break;
      case 0x42: // B — cursor down
        this.cursorY = Math.min(this.rows - 1, this.cursorY + (p[0] || 1));
        break;
      case 0x43: // C — cursor forward
        this.cursorX = Math.min(this.cols - 1, this.cursorX + (p[0] || 1));
        break;
      case 0x44: // D — cursor back
        this.cursorX = Math.max(0, this.cursorX - (p[0] || 1));
        break;
      case 0x48: // H — cursor position
      case 0x66: // f
        this.cursorY = Math.min(this.rows - 1, Math.max(0, (p[0] || 1) - 1));
        this.cursorX = Math.min(this.cols - 1, Math.max(0, (p[1] || 1) - 1));
        break;
      case 0x4a: // J — erase in display
        this.eraseDisplay(p[0] || 0);
        break;
      case 0x4b: // K — erase in line
        this.eraseLine(p[0] || 0);
        break;
      case 0x6d: // m — SGR
        this.applySgr(p);
        break;
      case 0x73: // s — save cursor
        this.savedX = this.cursorX;
        this.savedY = this.cursorY;
        break;
      case 0x75: // u — restore cursor
        this.cursorX = this.savedX;
        this.cursorY = this.savedY;
        break;
      case 0x68: // h — set mode
        break;
      case 0x6c: // l — reset mode
        break;
      case 0x6e: // n — DSR
        break;
      case 0x72: // r — set scrolling region
        break;
    }
  }

  private applySgr(params: number[]): void {
    if (params.length === 0 || params[0] === 0) {
      // Reset
      this.currentFg = -1;
      this.currentBg = -1;
      this.currentBold = false;
      this.currentItalic = false;
      this.currentUnderline = false;
      this.currentInverse = false;
      this.currentDim = false;
      this.currentBlink = false;
      this.currentStrikethrough = false;
      return;
    }
    
    for (let i = 0; i < params.length; i++) {
      const n = params[i];
      switch (n) {
        case 0: // reset
          this.currentFg = -1; this.currentBg = -1;
          this.currentBold = this.currentItalic = this.currentUnderline = false;
          this.currentInverse = this.currentDim = this.currentBlink = this.currentStrikethrough = false;
          break;
        case 1: this.currentBold = true; break;
        case 2: this.currentDim = true; break;
        case 3: this.currentItalic = true; break;
        case 4: this.currentUnderline = true; break;
        case 5: this.currentBlink = true; break;
        case 7: this.currentInverse = true; break;
        case 9: this.currentStrikethrough = true; break;
        case 22: this.currentBold = false; this.currentDim = false; break;
        case 23: this.currentItalic = false; break;
        case 24: this.currentUnderline = false; break;
        case 25: this.currentBlink = false; break;
        case 27: this.currentInverse = false; break;
        case 29: this.currentStrikethrough = false; break;
        case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
          this.currentFg = n - 30; break;
        case 38:
          if (params[i + 1] === 5 && i + 2 < params.length) {
            this.currentFg = params[i + 2]; i += 2; // 256-color
          } else if (params[i + 1] === 2 && i + 4 < params.length) {
            this.currentFg = 256 + params[i + 2] * 65536 + params[i + 3] * 256 + params[i + 4]; // RGB
            i += 4;
          }
          break;
        case 39: this.currentFg = -1; break;
        case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
          this.currentBg = n - 40; break;
        case 48:
          if (params[i + 1] === 5 && i + 2 < params.length) {
            this.currentBg = params[i + 2]; i += 2;
          } else if (params[i + 1] === 2 && i + 4 < params.length) {
            this.currentBg = 256 + params[i + 2] * 65536 + params[i + 3] * 256 + params[i + 4];
            i += 4;
          }
          break;
        case 49: this.currentBg = -1; break;
        case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
          this.currentFg = n - 82; break; // bright foreground
        case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
          this.currentBg = n - 92; break; // bright background
      }
    }
  }

  private putChar(char: string): void {
    if (this.cursorX >= this.cols) {
      this.cursorX = 0;
      this.lineFeed();
    }
    if (this.cursorY >= this.rows) {
      this.scrollUp();
      this.cursorY = this.rows - 1;
    }
    
    const fg = this.currentInverse ? this.currentBg : this.currentFg;
    const bg = this.currentInverse ? this.currentFg : this.currentBg;
    
    this.grid[this.cursorY][this.cursorX] = {
      char,
      fg,
      bg,
      bold: this.currentBold,
      italic: this.currentItalic,
      underline: this.currentUnderline,
      inverse: this.currentInverse,
      dim: this.currentDim,
      blink: this.currentBlink,
      strikethrough: this.currentStrikethrough,
    };
    this.cursorX++;
  }

  private lineFeed(): void {
    if (this.cursorY + 1 >= this.rows) {
      this.scrollUp();
    } else {
      this.cursorY++;
    }
  }

  private scrollUp(): void {
    this.grid.shift();
    const newRow: Cell[] = [];
    for (let x = 0; x < this.cols; x++) newRow.push(this.emptyCell());
    this.grid.push(newRow);
  }

  private eraseDisplay(mode: number): void {
    switch (mode) {
      case 0: // cursor to end
        for (let y = this.cursorY + 1; y < this.rows; y++)
          for (let x = 0; x < this.cols; x++) this.grid[y][x] = this.emptyCell();
        this.eraseLine(0);
        break;
      case 1: // beginning to cursor
        for (let y = 0; y < this.cursorY; y++)
          for (let x = 0; x < this.cols; x++) this.grid[y][x] = this.emptyCell();
        this.eraseLine(1);
        break;
      case 2: case 3: // entire screen
        for (let y = 0; y < this.rows; y++)
          for (let x = 0; x < this.cols; x++) this.grid[y][x] = this.emptyCell();
        this.cursorX = 0; this.cursorY = 0;
        break;
    }
  }

  private eraseLine(mode: number): void {
    const y = this.cursorY;
    switch (mode) {
      case 0:
        for (let x = this.cursorX; x < this.cols; x++) this.grid[y][x] = this.emptyCell();
        break;
      case 1:
        for (let x = 0; x <= this.cursorX; x++) this.grid[y][x] = this.emptyCell();
        break;
      case 2:
        for (let x = 0; x < this.cols; x++) this.grid[y][x] = this.emptyCell();
        break;
    }
  }

  private reset(): void {
    this.grid = this.createGrid();
    this.cursorX = 0;
    this.cursorY = 0;
    this.currentFg = -1;
    this.currentBg = -1;
    this.currentBold = false;
    this.currentItalic = false;
    this.currentUnderline = false;
    this.currentInverse = false;
    this.currentDim = false;
    this.currentBlink = false;
    this.currentStrikethrough = false;
  }
}

const enum ParserState {
  Ground,
  Escape,
  CsiEntry,
  CsiParam,
  CsiIntermediate,
  OscString,
  ApcString,
}

// ── ANSI color mapping ────────────────────────────────────────────

const ANSI_PALETTE: [number, number, number][] = [
  [0, 0, 0],       // 0 black
  [205, 0, 0],     // 1 red
  [0, 205, 0],     // 2 green
  [205, 205, 0],   // 3 yellow
  [0, 0, 238],     // 4 blue
  [205, 0, 205],   // 5 magenta
  [0, 205, 205],   // 6 cyan
  [192, 192, 192], // 7 white
  [128, 128, 128], // 8 bright black
  [255, 0, 0],     // 9 bright red
  [0, 255, 0],     // 10 bright green
  [255, 255, 0],   // 11 bright yellow
  [92, 92, 255],   // 12 bright blue
  [255, 0, 255],   // 13 bright magenta
  [0, 255, 255],   // 14 bright cyan
  [255, 255, 255], // 15 white
];

// Extended 216-color cube + grayscale (indices 16-255)
function build256Palette(): [number, number, number][] {
  const palette = ANSI_PALETTE.slice();
  // 216 colors: 6x6x6 cube (16-231)
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        palette.push([r * 51, g * 51, b * 51]);
  // 24 grayscale (232-255)
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    palette.push([v, v, v]);
  }
  return palette;
}

export const ANSI_256 = build256Palette();

export function ansiColorToRgb(index: number): [number, number, number] {
  if (index < 0) return [192, 192, 192]; // default fg: light gray
  if (index < 256) return ANSI_256[index];
  // True color (index >= 256): decode RGB from packed int
  const r = (index >> 16) & 0xff;
  const g = (index >> 8) & 0xff;
  const b = index & 0xff;
  return [r, g, b];
}
