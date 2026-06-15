/**
 * transport.ts — WebSocket transport layer
 *
 * Manages the connection to the Ghostty PTY server over WebSocket.
 * Handles auto-reconnection and provides a simple read/write interface.
 */

export type TransportEvent =
  | { type: "data"; data: Uint8Array }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "error"; message: string };

export class Transport {
  private ws: WebSocket | null = null;
  private url: string;
  private listeners: Set<(e: TransportEvent) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  constructor(url?: string) {
    this.url = url ?? this.defaultUrl();
  }

  private defaultUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const host = location.host || "localhost:9090";
    return `${proto}//${host}/ws`;
  }

  onEvent(cb: (e: TransportEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  connect(): void {
    this.intentionalClose = false;
    this.dispatch({ type: "connected" });
    try {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
      this.ws.addEventListener("open", () => {
        this.reconnectDelay = 1000;
        // Don't dispatch "connected" here — wait for first data.
        // Some clients want to know when the WebSocket is actually open.
      });
      this.ws.addEventListener("message", (e) => {
        let data: Uint8Array;
        if (e.data instanceof ArrayBuffer) {
          data = new Uint8Array(e.data);
        } else if (typeof e.data === "string") {
          const enc = new TextEncoder();
          data = enc.encode(e.data);
        } else if (e.data instanceof Uint8Array) {
          data = e.data;
        } else if (e.data instanceof Blob) {
          // Convert Blob to Uint8Array
          const reader = new FileReader();
          reader.onload = () => {
            this.dispatch({
              type: "data",
              data: new Uint8Array(reader.result as ArrayBuffer),
            });
          };
          reader.readAsArrayBuffer(e.data);
          return;
        } else {
          return;
        }
        this.dispatch({ type: "data", data });
      });
      this.ws.addEventListener("close", () => {
        if (!this.intentionalClose) {
          this.dispatch({ type: "disconnected" });
          this.scheduleReconnect();
        }
      });
      this.ws.addEventListener("error", () => {
        this.dispatch({ type: "error", message: "WebSocket error" });
      });
    } catch (err) {
      this.dispatch({ type: "error", message: String(err) });
      this.scheduleReconnect();
    }
  }

  send(data: Uint8Array | string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
      this.connect();
    }, this.reconnectDelay);
  }

  private dispatch(e: TransportEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}
