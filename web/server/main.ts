/**
 * Ghostty WebGPU PWA Server
 *
 * Serves the PWA client and proxies PTY I/O over WebSocket.
 * Run: deno task serve [--port PORT] [--shell SHELL]
 */

// ── Imports ────────────────────────────────────────────────────────
const HOST = "0.0.0.0";
const DEFAULT_PORT = 9090;
const DEFAULT_SHELL = Deno.env.get("SHELL") ?? "/bin/bash";

// ── CLI args ───────────────────────────────────────────────────────
const args = Deno.args;
let port = DEFAULT_PORT;
let shell = DEFAULT_SHELL;
let i = 0;
while (i < args.length) {
  if (args[i] === "--port" && i + 1 < args.length) {
    port = parseInt(args[i + 1], 10);
    i += 2;
  } else if (args[i] === "--shell" && i + 1 < args.length) {
    shell = args[i + 1];
    i += 2;
  } else {
    i += 1;
  }
}

// ── Static file serving ────────────────────────────────────────────
// Resolve client directory: flatpak install path first, then relative for dev
function resolveClientDir(): string {
  const flatpakPath = "/app/share/ghostty/web";
  try {
    const stat = Deno.statSync(flatpakPath);
    if (stat.isDirectory) return flatpakPath;
  } catch { /* not in flatpak */ }
  return new URL("../client/", import.meta.url).pathname;
}
const CLIENT_DIR = resolveClientDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".wgsl": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(reqPath: string): Response | null {
  // Security: prevent path traversal
  const safe = reqPath.replaceAll(/\.\./g, "").replaceAll(/\/\//g, "/");
  const filePath = CLIENT_DIR + (safe === "/" ? "/index.html" : safe);
  try {
    const content = Deno.readFileSync(filePath);
    const ext = filePath.slice(filePath.lastIndexOf("."));
    const contentType = MIME[ext] ?? "application/octet-stream";
    return new Response(content, {
      headers: { "content-type": contentType },
    });
  } catch {
    // SPA fallback: serve index.html for unknown paths
    if (!reqPath.startsWith("/ws")) {
      try {
        const index = Deno.readFileSync(CLIENT_DIR + "/index.html");
        return new Response(index, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── PTY bridge ─────────────────────────────────────────────────────
/**
 * Spawn a shell with a PTY using `script`.
 * This creates a true PTY so programs like vim work.
 */
function spawnPty(
  shellCmd: string,
): { process: Deno.ChildProcess; writer: WritableStreamDefaultWriter<Uint8Array>; } {
  // Use `script` to create a PTY. The -q flag makes it quiet, -f flushes.
  // stdin/stdout of the script process are the PTY I/O.
  const cmd = new Deno.Command("script", {
    args: ["-qfc", shellCmd, "/dev/null"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: Deno.env.get("LANG") ?? "en_US.UTF-8",
      HOME: Deno.env.get("HOME") ?? "/",
      USER: Deno.env.get("USER") ?? "ghostty",
      PATH: Deno.env.get("PATH") ?? "/usr/bin",
      SHELL: shellCmd,
    },
  });
  const proc = cmd.spawn();
  const writer = proc.stdin.getWriter();
  return { process: proc, writer };
}

// ── WebSocket handler ──────────────────────────────────────────────
function handleWs(sock: WebSocket) {
  console.log(`[ws] new terminal session`);

  const { process, writer } = spawnPty(shell);
  let open = true;

  // PTY stdout → WebSocket
  (async () => {
    const reader = process.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(value);
        }
      }
    } catch {
      // process ended
    }
    if (open) {
      console.log(`[ws] pty exited`);
      open = false;
      try { sock.close(); } catch { /* swallow */ }
    }
  })();

  // WebSocket → PTY stdin
  sock.addEventListener("message", async (e) => {
    if (typeof e.data === "string") {
      // Text messages are encoded as UTF-8
      const enc = new TextEncoder();
      await writer.write(enc.encode(e.data));
    } else if (e.data instanceof ArrayBuffer) {
      await writer.write(new Uint8Array(e.data));
    } else if (e.data instanceof Uint8Array) {
      await writer.write(e.data);
    }
  });

  // Handle WebSocket close
  sock.addEventListener("close", () => {
    open = false;
    console.log(`[ws] client disconnected`);
    try { writer.close(); } catch { /* swallow */ }
    try { process.kill("SIGTERM"); } catch { /* swallow */ }
  });

  // Handle WebSocket error
  sock.addEventListener("error", (e) => {
    console.error(`[ws] error:`, (e as ErrorEvent).message);
    open = false;
    try { process.kill("SIGTERM"); } catch { /* swallow */ }
  });
}

// ── Main server ────────────────────────────────────────────────────
Deno.serve({ hostname: HOST, port }, (req: Request): Response => {
  const url = new URL(req.url);

  // WebSocket upgrade
  if (url.pathname === "/ws") {
    const upgrade = req.headers.get("upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      handleWs(socket);
      return response;
    }
    return new Response("WebSocket required", { status: 426 });
  }

  // Static file serving
  const response = serveStatic(url.pathname);
  if (response) return response;

  return new Response("Not Found", { status: 404 });
});

console.log(`Ghostty WebGPU PWA server running on http://${HOST}:${port}`);
console.log(`  Shell: ${shell}`);
