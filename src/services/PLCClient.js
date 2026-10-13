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

// A live stream pushes a full snapshot every 50 ms, so nothing arriving for this
// long means the peer is gone even though EventSource is still "connecting".
const STREAM_STALE_MS = 5000;

export class PLCClient {
  /**
   * @param {string} address — host:port, e.g. "192.168.1.100:7070"
   */
  constructor(address) {
    this._base = `http://${address}`;
    this._es = null; // active EventSource
    this._lastEventAt = 0; // Date.now() of the last byte actually received
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
   * Write a variable through the target's force-write mailbox. Resolves only
   * after the runtime APPLIED it (KronServer waits for the runtime's ack), so
   * a rejection here is real: not running, stalled (deadline_exceeded),
   * mailbox full (resource_exhausted) or a runtime/server version mismatch.
   * @param {string} name  — IEC variable name
   * @param {boolean|number|string} value — runtime value; a 64-bit integer
   *   beyond ±2^53 MUST be a decimal string (a JSON number is a double)
   * @param {'force'|'pulse'|'unforce'} [mode] — force (hold, default), pulse
   *   (write once, the logic owns it from the same scan) or unforce (release;
   *   a non-null value is also written once)
   */
  async writeVar(name, value, mode = 'force') {
    // `mode` is sent only when it is not the default: a KronServer older than
    // the field rejects unknown JSON fields, and plain force must keep working
    // against it (it will then fail loudly on the protocol check instead).
    const body = { name, value };
    if (mode && mode !== 'force') body.mode = mode;
    return this._unary('WriteVar', body);
  }

  /** Clear all force flags so the PLC resumes normal variable sync. */
  async clearAllForces() {
    return this._unary('ClearAllForces', {});
  }

  // ---------------------------------------------------------------------------
  // Live variable streaming — SSE (GET /stream/vars)
  // ---------------------------------------------------------------------------

  /**
   * Stream live variable values. The server pushes a snapshot every 50 ms.
   *
   * @param {function(vars: Object): void} onUpdate — called on each snapshot.
   *   The payload may carry the reserved key `__forced` (the forced set, NOT a
   *   variable — see utils/forcedVars.splitForcedPayload); the caller splits it.
   * @param {function(err: Error): void}   onError  — called on fatal connection error
   * @param {{prefixes?: string[], names?: string[]}} [sub] — what to stream.
   *   `prefixes` are key prefixes (a POU's keys share `prog_<Name>_`, every
   *   global shares `prog__`), `names` explicit keys. Omitted or empty = every
   *   variable, which is also what a KronServer older than this filter does
   *   with the query — so an un-upgraded target keeps working, just unfiltered.
   *   The subscription is fixed for the life of the connection: to change it,
   *   stop the stream and start a new one.
   * @returns {function} stop — call to cancel the stream
   */
  streamVars(onUpdate, onError, sub = null) {
    // Close any previously active stream.
    if (this._es) {
      this._es.close();
      this._es = null;
    }

    const q = new URLSearchParams();
    if (sub?.prefixes?.length) q.set('p', sub.prefixes.join(','));
    if (sub?.names?.length) q.set('v', sub.names.join(','));
    const query = q.toString();
    const es = new EventSource(`${this._base}/stream/vars${query ? `?${query}` : ''}`);
    this._es = es;
    this._lastEventAt = Date.now();

    es.onopen = () => { this._lastEventAt = Date.now(); };

    es.onmessage = (event) => {
      this._lastEventAt = Date.now();
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

  /**
   * True only while the stream is actually DELIVERING data.
   *
   * ⚠️ Never use `isStreaming` as proof that the peer is alive: EventSource
   * retries a dead host forever and its readyState stays CONNECTING (never
   * CLOSED), so `isStreaming` remains true indefinitely after the target is
   * powered off. Liveness must be judged by the last received event.
   */
  get isStreamHealthy() {
    if (!this.isStreaming) return false;
    return Date.now() - this._lastEventAt < STREAM_STALE_MS;
  }

  /** ms since the last event was received (Infinity if never / no stream). */
  get msSinceLastEvent() {
    return this._lastEventAt ? Date.now() - this._lastEventAt : Infinity;
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

    let json = null;
    try { json = await res.json(); } catch { /* empty / non-JSON error body */ }

    if (!res.ok) {
      const msg = json?.message || json?.error || res.statusText;
      throw new Error(`[PLCClient] ${method}: ${msg}`);
    }
    return json;
  }
}
