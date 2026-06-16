/**
 * app.ts — Ghostty Remote PWA main entrypoint
 *
 * Uses JS ANSI parser for terminal emulation, Canvas2D for rendering.
 * WebSocket transport for PTY I/O.
 */

import { Transport } from "./transport.js";
import { AnsiParser } from "./ansi.js";
import { TerminalRenderer } from "./renderer.js";

// ── State ──────────────────────────────────────────────────────────
const canvas = document.getElementById("terminal") as HTMLCanvasElement;
const connectingEl = document.getElementById("connecting")!;
const statusText = document.getElementById("status-text")!;

const transport = new Transport();
const renderer = new TerminalRenderer(canvas, {
  fontWidth: 8.4,
  fontHeight: 16,
});

let parser: AnsiParser;
let connected = false;
let rafId = 0;

// ── Initialization ─────────────────────────────────────────────────
async function init() {
  statusText.textContent = "Initializing renderer...";
  await renderer.init();
  updateGrid();
  parser = new AnsiParser(renderer.getGrid().cols, renderer.getGrid().rows);

  // Wire Kitty graphics images to the renderer
  parser.onKittyImage = (img) => renderer.addKittyImage(img);

  statusText.textContent = "Connecting...";
  setupTransport();
  transport.connect();

  setupInput();
  startRenderLoop();
}

// ── Transport ──────────────────────────────────────────────────────
function setupTransport() {
  transport.onEvent((e) => {
    switch (e.type) {
      case "data":
        parser.feed(e.data);
        break;
      case "connected":
        connected = true;
        connectingEl.classList.add("hidden");
        break;
      case "disconnected":
        connected = false;
        connectingEl.classList.remove("hidden");
        statusText.textContent = "Disconnected. Reconnecting...";
        break;
      case "error":
        statusText.textContent = `Error: ${e.message}`;
        break;
    }
  });
}

// ── Grid ───────────────────────────────────────────────────────────
function updateGrid() {
  const { rows, cols } = renderer.getGrid();
  if (rows > 0 && cols > 0) {
    parser?.resize(cols, rows);
    renderer.setGrid(rows, cols);
  }
}

// ── Input ──────────────────────────────────────────────────────────
function setupInput() {
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || (e.ctrlKey && e.shiftKey)) return;
    e.preventDefault();

    const encoded = encodeKey(e.key, e.ctrlKey, e.altKey);
    if (encoded) transport.send(encoded);
  });

  // IME
  const inputEl = document.createElement("input");
  inputEl.style.cssText =
    "position:fixed;top:-100px;left:0;width:1px;height:1px;opacity:0;";
  document.body.appendChild(inputEl);

  inputEl.addEventListener("compositionend", () => {
    const text = inputEl.value;
    if (text) transport.send(text);
    inputEl.value = "";
  });

  canvas.addEventListener("click", () => inputEl.focus());

  document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text) transport.send(text);
  });

  let resizeTimer: ReturnType<typeof setTimeout>;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateGrid, 100);
  });

  document.addEventListener("gesturestart", (e) => e.preventDefault());
}

function encodeKey(key: string, ctrl: boolean, alt: boolean): string | Uint8Array | null {
  const text = key.length === 1 ? key : null;
  if (text && !ctrl && !alt) return text;
  if (key === "Enter") return "\r";
  if (key === "Backspace") return "\x7f";
  if (key === "Tab") return "\t";
  if (key === "Escape") return "\x1b";
  if (key === "ArrowUp") return "\x1b[A";
  if (key === "ArrowDown") return "\x1b[B";
  if (key === "ArrowRight") return "\x1b[C";
  if (key === "ArrowLeft") return "\x1b[D";
  if (key === "Home") return "\x1b[H";
  if (key === "End") return "\x1b[F";
  if (key === "PageUp") return "\x1b[5~";
  if (key === "PageDown") return "\x1b[6~";
  if (key === "Delete") return "\x1b[3~";
  if (key === "Insert") return "\x1b[2~";
  if (ctrl && text && text.length === 1) {
    const c = text.charCodeAt(0);
    if (c >= 0x40 && c <= 0x5f) return String.fromCodePoint(c - 0x40);
    if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(c - 0x60);
  }
  return null;
}

// ── Render loop ────────────────────────────────────────────────────
function startRenderLoop() {
  function frame() {
    rafId = requestAnimationFrame(frame);
    if (parser) {
      renderer.scheduleDraw(parser.grid, parser.cursorX, parser.cursorY);
    }
    renderer.drawFrame();
  }
  rafId = requestAnimationFrame(frame);
}

// ── PWA ────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("[app] SW registration failed:", err);
  });
}

init();
