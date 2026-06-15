/**
 * app.ts — Ghostty Remote PWA main entrypoint
 *
 * Initializes renderer, WASM terminal, and WebSocket transport.
 * Handles keyboard/mouse input and the render loop.
 */

import { Transport } from "./transport.js";
import { Terminal } from "./terminal.js";
import { TerminalRenderer } from "./renderer.js";

// ── State ──────────────────────────────────────────────────────────
const canvas = document.getElementById("terminal") as HTMLCanvasElement;
const connectingEl = document.getElementById("connecting")!;
const statusText = document.getElementById("status-text")!;

const transport = new Transport();
const terminal = new Terminal();
const renderer = new TerminalRenderer(canvas, {
  fontWidth: 8.4,
  fontHeight: 16,
});

let connected = false;
let rafId = 0;

// ── Initialization ─────────────────────────────────────────────────
async function init() {
  statusText.textContent = "Initializing WebGPU...";
  await renderer.init();

  statusText.textContent = "Loading terminal emulator...";
  try {
    await terminal.load("/ghostty-vt.wasm");
  } catch (err) {
    console.warn("[app] WASM load error:", err);
  }

  updateGrid();
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
        terminal.write(e.data);
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
    terminal.resize(rows, cols);
    renderer.setGrid(rows, cols);
  }
}

// ── Input ──────────────────────────────────────────────────────────
function setupInput() {
  document.addEventListener("keydown", (e) => {
    // Allow browser shortcuts with Meta/Ctrl+Shift
    if (e.metaKey || (e.ctrlKey && e.shiftKey)) return;
    e.preventDefault();

    const encoded = terminal.encodeKey(e.key, e.ctrlKey, e.altKey, e.metaKey);
    if (encoded) transport.send(encoded);
  });

  // IME composition
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

  // Paste
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text) transport.send(text);
  });

  // Resize
  let resizeTimer: ReturnType<typeof setTimeout>;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderer.resize();
      updateGrid();
    }, 100);
  });

  // Prevent zoom
  document.addEventListener("gesturestart", (e) => e.preventDefault());
}

// ── Render loop ────────────────────────────────────────────────────
function startRenderLoop() {
  function frame() {
    rafId = requestAnimationFrame(frame);

    // Throttle to ~30fps when idle
    const rows = terminal.getRenderRows();
    const cursor = terminal.getCursor();
    const colors = terminal.getColors();

    renderer.scheduleDraw(rows, cursor, colors);
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

// ── Go ─────────────────────────────────────────────────────────────
init();
