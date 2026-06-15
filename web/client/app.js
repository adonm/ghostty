/**
 * app.ts — Ghostty Remote PWA main entrypoint
 *
 * Initializes the WebGPU renderer, WASM terminal, and WebSocket transport.
 * Handles keyboard/mouse input and the render loop.
 */

import { Transport } from "./transport.js";
import { Terminal } from "./terminal.js";
import { WebGPURenderer } from "./renderer.js";

// ── State ──────────────────────────────────────────────────────────
const canvas = document.getElementById("terminal") as HTMLCanvasElement;
const connectingEl = document.getElementById("connecting")!;
const statusText = document.getElementById("status-text")!;

const transport = new Transport();
const terminal = new Terminal();
const renderer = new WebGPURenderer(canvas, {
  fontWidth: 8,
  fontHeight: 16,
});

let connected = false;
let rafId = 0;

// ── Initialization ─────────────────────────────────────────────────
async function init() {
  statusText.textContent = "Initializing WebGPU...";

  const gpuOk = await renderer.init();
  if (!gpuOk) {
    statusText.textContent = "WebGPU not supported. Use Chrome 113+ or Edge 113+.";
    return;
  }

  statusText.textContent = "Loading terminal emulator...";
  try {
    await terminal.load("/ghostty-vt.wasm");
  } catch {
    // Continue with fallback mode
  }

  updateGrid();
  statusText.textContent = "Connecting...";
  setupTransport();
  transport.connect();
}

// ── Transport setup ────────────────────────────────────────────────
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
        statusText.textContent = "Reconnecting...";
        break;
      case "error":
        statusText.textContent = `Error: ${e.message}`;
        break;
    }
  });
}

// ── Grid management ────────────────────────────────────────────────
function updateGrid() {
  const { rows, cols } = renderer.getGridFromCanvas();
  terminal.resize(rows, cols);
  renderer.setGrid(rows, cols);
}

// ── Input handling ─────────────────────────────────────────────────
function setupInput() {
  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.altKey) return; // Browser shortcuts
    e.preventDefault();

    const encoded = terminal.encodeKey(
      e.key,
      e.ctrlKey,
      false,
      false,
    );
    if (encoded) {
      transport.send(encoded);
    }
  });

  // Handle composition (IME) - send composed text
  canvas.addEventListener("compositionend", (e) => {
    const text = e.data;
    if (text) transport.send(text);
  });

  // Touch/mouse for mobile
  canvas.addEventListener("click", () => {
    // Focus for keyboard
    canvas.focus();
  });

  // Handle paste
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text) {
      transport.send(text);
    }
  });

  // Resize
  window.addEventListener("resize", () => {
    updateGrid();
  });

  // Prevent zooming on mobile
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
  document.addEventListener("gestureend", (e) => e.preventDefault());
}

// ── Render loop ────────────────────────────────────────────────────
function renderLoop() {
  rafId = requestAnimationFrame(renderLoop);

  if (!connected && !terminal) return;

  try {
    const renderRows = terminal.getRenderRows();
    const cursor = terminal.getCursor();
    const colors = terminal.getColors();
    renderer.render(renderRows, cursor, colors);
  } catch (err) {
    console.error("[app] render error:", err);
  }
}

// ── Service worker registration ────────────────────────────────────
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[app] ServiceWorker registration failed:", err);
    });
  }
}

// ── Start ──────────────────────────────────────────────────────────
registerSW();
setupInput();
init();
renderLoop();
