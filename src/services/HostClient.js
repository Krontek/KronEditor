/**
 * HostClient.js — HTTP client for kron-host-agent.
 *
 * The host agent runs locally on the developer's PC and replaces the
 * Tauri Rust backend. Vite dev mode proxies /api/host/* → http://localhost:7171.
 * Production build (host agent serving the embedded frontend) is same origin.
 *
 * All endpoints return either `{ ok: true, ... }` or `{ ok: false, error }`.
 * Methods on this class always resolve to the JSON body and let the caller
 * decide how to handle `ok === false` (consistent with how Tauri's invoke
 * threw errors on failure — see _wrap helper).
 */

const DEFAULT_BASE = '';

function _wrap(promise) {
  return promise.then(async (res) => {
    let json;
    try {
      json = await res.json();
    } catch (_) {
      throw new Error(`HTTP ${res.status} (no JSON body)`);
    }
    if (!res.ok && json?.ok !== true) {
      const msg = json?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  });
}

function _post(path, body) {
  return _wrap(
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  );
}

function _get(path) {
  return _wrap(fetch(path));
}

export class HostClient {
  constructor(baseUrl = DEFAULT_BASE) {
    this._base = baseUrl;
  }

  _p(suffix) {
    return this._base + suffix;
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  async health() {
    return _get(this._p('/api/host/health'));
  }
  async buildDir() {
    return _get(this._p('/api/host/build-dir'));
  }

  // ── file I/O ──────────────────────────────────────────────────────────────
  async writePlcFiles({ header, source, variableTable, hal }) {
    return _post(this._p('/api/host/write-plc-files'), { header, source, variableTable, hal });
  }
  async getStandardHeaders() {
    const j = await _post(this._p('/api/host/standard-headers'), {});
    // Return Vec<(name, content)> shape matching the old Tauri command.
    return (j.headers || []).map((h) => [h.name, h.content]);
  }
  async readFile(path) {
    const j = await _post(this._p('/api/host/read-file'), { path });
    return j.content;
  }
  async writeFile(path, content) {
    return _post(this._p('/api/host/write-file'), { path, content });
  }
  async listDir(path) {
    const j = await _post(this._p('/api/host/list-dir'), { path });
    return j.entries || [];
  }

  // ── compile ───────────────────────────────────────────────────────────────
  /**
   * Generic gcc/clang invocation (PoC helper).
   */
  async build({ sources, output = 'runtime.bin', compilerArgs = [], compiler = 'gcc' }) {
    return _post(this._p('/api/host/build'), { sources, output, compilerArgs, compiler });
  }
  async compileSimulation() {
    const j = await _post(this._p('/api/host/compile-simulation'), {});
    if (!j.ok) throw new Error(j.error || 'compileSimulation failed');
    return j.binaryPath;
  }
  async compileForTarget({ header, source, variableTable, hal, boardId, outputName }) {
    const j = await _post(this._p('/api/host/compile-for-target'), {
      header, source, variableTable, hal, boardId, outputName,
    });
    if (!j.ok) throw new Error(j.error || 'compileForTarget failed');
    return j.binaryPath;
  }

  // ── runtime ───────────────────────────────────────────────────────────────
  async runSimulation() {
    return _post(this._p('/api/host/run-simulation'), {});
  }
  async stopSimulation() {
    return _post(this._p('/api/host/stop-simulation'), {});
  }
  async writeVariable(name, value) {
    return _post(this._p('/api/host/write-variable'), { name, value: String(value) });
  }

  /**
   * Subscribe to PLC variable updates. Matches the existing PLCClient.streamVars
   * signature (flat snapshot of `{ varName: value, ... }` per message).
   * Returns a function that, when called, closes the stream.
   */
  streamPlcVariables(onUpdate, onError) {
    const es = new EventSource(this._p('/api/host/plc-variables'));
    es.onmessage = (event) => {
      try {
        onUpdate(JSON.parse(event.data));
      } catch (e) {
        console.warn('[HostClient] plc-variables parse error', e);
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && onError) {
        onError(new Error('plc-variables stream closed'));
      }
    };
    return () => es.close();
  }

  /**
   * Subscribe to generic host-agent events (build-command,
   * library-update-progress, simulation-output, ec-state-changed, etc).
   * Callback receives `{ topic, data }`.
   */
  streamEvents(onMessage, onError) {
    const es = new EventSource(this._p('/api/host/events'));
    es.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch (e) {
        console.warn('[HostClient] events parse error', e);
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && onError) {
        onError(new Error('events stream closed'));
      }
    };
    return () => es.close();
  }

  // ── deploy ────────────────────────────────────────────────────────────────
  async checkServerStatus(serverAddr) {
    const j = await _post(this._p('/api/host/check-server-status'), { serverAddr });
    return j.status;
  }
  async deployToServer(serverAddr) {
    const j = await _post(this._p('/api/host/deploy-to-server'), { serverAddr });
    return j.message || 'Deployed';
  }
  async deployServerToTarget(payload) {
    return _post(this._p('/api/host/deploy-server-to-target'), payload);
  }

  // ── library / server updates ──────────────────────────────────────────────
  async updateLibraries(repos) {
    return _post(this._p('/api/host/update-libraries'), { repos });
  }
  async updateServer() {
    return _post(this._p('/api/host/update-server'), {});
  }

  // ── HMI ───────────────────────────────────────────────────────────────────
  async startHmiServer(port, layoutJson) {
    return _post(this._p('/api/host/start-hmi-server'), { port, layoutJson });
  }
  async stopHmiServer() {
    return _post(this._p('/api/host/stop-hmi-server'), {});
  }
  async pushHmiVariables(varsJson) {
    return _post(this._p('/api/host/push-hmi-variables'), { varsJson });
  }
  async pollHmiWrites() {
    const j = await _post(this._p('/api/host/poll-hmi-writes'), {});
    return j.writes || [];
  }

  // ── AI Agent (local models via Ollama) ─────────────────────────────────────
  /**
   * Report whether a local Ollama daemon is reachable and which models are
   * already pulled. `baseUrl` is optional (defaults to http://localhost:11434).
   * Returns `{ ok, running, baseUrl, models: [{name, size}], error? }`.
   */
  async ollamaStatus(baseUrl) {
    return _post(this._p('/api/host/ollama-status'), { baseUrl });
  }
  /**
   * One-click bootstrap: if the daemon is down, locate or download a user-local
   * ollama binary (no sudo) and start `ollama serve`. Returns immediately;
   * progress arrives on streamEvents under topic `ollama-setup-progress` as
   * `{ phase, percent, done, error }`. On `done && !error` the daemon is up.
   */
  async ollamaSetup(baseUrl) {
    return _post(this._p('/api/host/ollama-setup'), { baseUrl });
  }
  /**
   * Kick off a background `ollama pull <model>`. Returns immediately; progress
   * arrives on the generic event stream (streamEvents) under topic
   * `ollama-pull-progress` as `{ model, status, completed, total, percent, done, error }`.
   */
  async ollamaPull(model, baseUrl) {
    return _post(this._p('/api/host/ollama-pull'), { model, baseUrl });
  }

  // ── EtherCAT ──────────────────────────────────────────────────────────────
  async buildSoem() {
    return _post(this._p('/api/host/build-soem'), {});
  }
  async buildCanopen() {
    return _post(this._p('/api/host/build-canopen'), {});
  }
  async ecRequestState(state) {
    return _post(this._p('/api/host/ec-request-state'), { state });
  }
  async listNetworkInterfaces() {
    const j = await _get(this._p('/api/host/list-network-interfaces'));
    return j.interfaces || [];
  }
}

// Shared singleton — most callers just want `host` from this module.
export const host = new HostClient();
