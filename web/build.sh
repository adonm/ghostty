#!/bin/bash
# Build the Ghostty WebGPU PWA bundle
#
# Prerequisites:
#   - Zig 0.15.x (for building ghostty-vt.wasm)
#   - Deno (for bundling the server; optional if just building WASM)
#
# Usage:
#   ./web/build.sh              # Build WASM + copy to client dir
#   ./web/build.sh --serve       # Build + start dev server
#   ./web/build.sh --bundle      # Build + bundle Deno server into single binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Building ghostty-vt.wasm ==="
cd "$ROOT_DIR"
zig build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall 2>&1

# Copy WASM to client directory
WASM_SRC="$ROOT_DIR/zig-out/bin/ghostty-vt.wasm"
WASM_DST="$SCRIPT_DIR/client/ghostty-vt.wasm"
if [ -f "$WASM_SRC" ]; then
  cp "$WASM_SRC" "$WASM_DST"
  echo "  -> Copied to $WASM_DST ($(du -h "$WASM_DST" | cut -f1))"
else
  echo "  WARNING: $WASM_SRC not found. Skipping WASM copy."
fi

echo ""
echo "=== PWA client files ==="
ls -la "$SCRIPT_DIR/client/"

# Handle command flags
MODE="${1:-}"
case "$MODE" in
  --serve)
    echo ""
    echo "=== Starting Deno dev server ==="
    cd "$SCRIPT_DIR"
    exec deno run --allow-net --allow-read --allow-run --allow-env server/main.ts
    ;;
  --bundle)
    echo ""
    echo "=== Bundling Deno server ==="
    cd "$SCRIPT_DIR"
    deno compile --allow-net --allow-read --allow-run --allow-env \
      --output "$ROOT_DIR/zig-out/bin/ghostty-server" \
      server/main.ts
    echo "  -> Bundled to zig-out/bin/ghostty-server"
    ;;
esac
