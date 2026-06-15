#!/bin/bash
# Build the Ghostty WebGPU PWA bundle
#
# Prerequisites:
#   - Zig 0.15.2 (auto-downloaded if not found)
#   - Deno (auto-downloaded if not found; for dev server)
#
# Usage:
#   ./web/build.sh              # Build WASM + copy to client dir
#   ./web/build.sh --serve       # Build + start dev server
#   ./web/build.sh --bundle      # Build + bundle Deno server into single binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="/tmp/ghostty-build-cache"

# ── Find or download Zig ──────────────────────────────────────────────
ZIG_VERSION="0.15.2"
ZIG_DIR="$CACHE_DIR/zig-$ZIG_VERSION"

if [ ! -x "$ZIG_DIR/zig" ]; then
  echo "=== Downloading Zig $ZIG_VERSION ==="
  mkdir -p "$(dirname "$ZIG_DIR")"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  ZIG_ARCH="x86_64-linux" ;;
    aarch64) ZIG_ARCH="aarch64-linux" ;;
    *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  ZIG_URL="https://ziglang.org/download/$ZIG_VERSION/zig-${ZIG_ARCH}-$ZIG_VERSION.tar.xz"
  curl -sL "$ZIG_URL" -o "$CACHE_DIR/zig.tar.xz"
  tar -xf "$CACHE_DIR/zig.tar.xz" -C "$CACHE_DIR/"
  # Remove version suffix from dir name
  mv "$CACHE_DIR/zig-${ZIG_ARCH}-$ZIG_VERSION" "$ZIG_DIR"
  rm "$CACHE_DIR/zig.tar.xz"
  echo "  -> Zig installed at $ZIG_DIR"
fi
export PATH="$ZIG_DIR:$PATH"

# ── Find or download Deno (for serve/bundle) ─────────────────────────
DENO_VERSION="v2.8.3"
DENO_BIN="$CACHE_DIR/deno-$DENO_VERSION"

if [ ! -x "$DENO_BIN" ]; then
  echo "=== Downloading Deno $DENO_VERSION ==="
  mkdir -p "$CACHE_DIR"
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  DENO_TRIPLE="x86_64-unknown-linux-gnu" ;;
    aarch64) DENO_TRIPLE="aarch64-unknown-linux-gnu" ;;
    *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  DENO_URL="https://github.com/denoland/deno/releases/download/$DENO_VERSION/deno-${DENO_TRIPLE}.zip"
  curl -sL "$DENO_URL" -o "$CACHE_DIR/deno.zip"
  unzip -o "$CACHE_DIR/deno.zip" -d "$CACHE_DIR/"
  mv "$CACHE_DIR/deno" "$DENO_BIN"
  rm "$CACHE_DIR/deno.zip"
  chmod +x "$DENO_BIN"
  echo "  -> Deno installed at $DENO_BIN"
fi

# ── Build WASM ────────────────────────────────────────────────────────
WASM_SRC="$ROOT_DIR/zig-out/bin/ghostty-vt.wasm"
WASM_DST="$SCRIPT_DIR/client/ghostty-vt.wasm"

if [ ! -f "$WASM_SRC" ] || [ "$WASM_SRC" -ot "$ROOT_DIR/src/lib_vt.zig" ]; then
  echo "=== Building ghostty-vt.wasm ==="
  cd "$ROOT_DIR"
  rm -rf "$ROOT_DIR/.zig-cache"
  zig build \
    -Demit-lib-vt \
    -Dtarget=wasm32-freestanding \
    -Doptimize=ReleaseSmall \
    --cache-dir "$CACHE_DIR/zig-cache" \
    2>&1
fi

if [ -f "$WASM_SRC" ]; then
  cp "$WASM_SRC" "$WASM_DST"
  echo "  -> WASM: $WASM_DST ($(du -h "$WASM_DST" | cut -f1))"
else
  echo "  WARNING: $WASM_SRC not found. Run './web/build.sh' to build."
fi

# ── Build PTY bridge ───────────────────────────────────────────────────
PTY_SRC="$ROOT_DIR/src/pty_bridge.zig"
PTY_DST="$SCRIPT_DIR/server/pty-bridge"

if [ ! -f "$PTY_DST" ] || [ "$PTY_SRC" -nt "$PTY_DST" ]; then
  echo "=== Building pty-bridge ==="
  zig build-exe -OReleaseSmall -lc "$PTY_SRC" \
    --name pty-bridge \
    -femit-bin="$PTY_DST" \
    2>&1
  echo "  -> PTY bridge: $PTY_DST"
fi

# ── Handle command flags ──────────────────────────────────────────────
MODE="${1:-}"
case "$MODE" in
  --serve)
    echo ""
    echo "=== Starting Deno dev server ==="
    cd "$SCRIPT_DIR"
    exec "$DENO_BIN" run \
      --allow-net --allow-read --allow-run --allow-env \
      server/main.ts
    ;;
  --bundle)
    echo ""
    echo "=== Bundling Deno server ==="
    cd "$SCRIPT_DIR"
    "$DENO_BIN" compile \
      --allow-net --allow-read --allow-run --allow-env \
      --output "$ROOT_DIR/zig-out/bin/ghostty-server" \
      server/main.ts
    echo "  -> Bundled to zig-out/bin/ghostty-server"
    ;;
esac

echo ""
echo "=== PWA client files ==="
ls -la "$SCRIPT_DIR/client/"
