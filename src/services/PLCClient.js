/**
 * PLCClient.js — ConnectRPC client for PLCService.
 *
 * Unary calls  (start / stop / writeVar / clearAllForces):
 *   POST /plc.v1.PLCService/<Method>
 *   Content-Type: application/json
 *   Connect-Protocol-Version: 1
 *
 * Variable streaming (streamVars):
 *   GET /stream/vars  →  Server-Sent Events (text/event-stream)
 *   Each event data is a JSON object: { varName: value, ... }
 *
 * SSE is used for streaming instead of the Connect streaming protocol because
 * Tauri 2.x / WebKitGTK buffers fetch() responses end-to-end, making fetch
 * streaming unusable for long-lived server-push connections.
 */

const SERVICE = 'plc.v1.PLCService';

export class PLCClient {
  /**
   * @param {string} address — host:port, e.g. "192.168.1.100:7070"
   */
  constructor(address) {
    this._base = `http://${address}`;
    this._es = null; // active EventSource
  }

  // ---------------------------------------------------------------------------
  // Unary RPCs (ConnectRPC / JSON)
  // ---------------------------------------------------------------------------

  /** Start the PLC runtime. Returns { pid } on success. */
  async start() {
    return this._unary('Start', {});
  }

  /** Stop the PLC runtime. */
  async stop() {
    return this._unary('Stop', {});
  }

  /**
   * Force-write a variable into shared memory.
   * @param {string} name  — IEC variable name
   * @param {boolean|number|string} value — runtime value
   */
  async writeVar(name, value) {
    return this._unary('WriteVar', { name, value });
  }

  /** Clear all force flags so the PLC resumes normal variable sync. */
  async clearAllForces() {
    return this._unary('ClearAllForces', {});
  }

  // ---------------------------------------------------------------------------
  // Live variable streaming — SSE (GET /stream/vars)
  // ---------------------------------------------------------------------------

  /**
   * Stream live variable values. Server pushes a full snapshot every 50 ms.
   *
   * @param {function(vars: Object): void} onUpdate — called on each snapshot
   * @param {function(err: Error): void}   onError  — called on fatal connection error
   * @returns {function} stop — call to cancel the stream
   */
  streamVars(onUpdate, onError) {
    // Close any previously active stream.
    if (this._es) {
      this._es.close();
      this._es = null;
    }

    const es = new EventSource(`${this._base}/stream/vars`);
    this._es = es;

    es.onmessage = (event) => {
      try {
        const vars = JSON.parse(event.data);
        onUpdate(vars);
      } catch (e) {
        console.warn('[PLCClient] SSE parse error', e);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors (readyState → CONNECTING).
      // Only escalate if the connection is permanently closed.
      if (es.readyState === EventSource.CLOSED) {
        const err = new Error('[PLCClient] SSE connection closed');
        console.error(err.message);
        if (onError) onError(err);
      }
    };

    return () => {
      es.close();
      if (this._es === es) this._es = null;
    };
  }

  /** Close the active SSE stream (if any). */
  close() {
    if (this._es) {
      this._es.close();
      this._es = null;
    }
  }

  /** True while an SSE connection is open or reconnecting. */
  get isStreaming() {
    return this._es !== null && this._es.readyState !== EventSource.CLOSED;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  async _unary(method, body) {
    const url = `${this._base}/${SERVICE}/${method}`;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`[PLCClient] ${method}: network error — ${err.message}`);
    }

    const json = await res.json();

    if (!res.ok) {
      const msg = json?.message || json?.error || res.statusText;
      throw new Error(`[PLCClient] ${method}: ${msg}`);
    }
    return json;
  }
}
