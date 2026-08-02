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

function _post(path, body, signal) {
  return _wrap(
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
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
  async homeDir() {
    const j = await _get(this._p('/api/host/home-dir'));
    return j.home;
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
    if (!j.ok) {
      // Attach the compiler output (clang stderr) so the UI can show WHY it failed.
      const e = new Error(j.error || 'compileSimulation failed');
      e.log = j.log || '';
      throw e;
    }
    return j.binaryPath;
  }
  async compileForTarget({ header, source, variableTable, hal, boardId, outputName }) {
    const j = await _post(this._p('/api/host/compile-for-target'), {
      header, source, variableTable, hal, boardId, outputName,
    });
    if (!j.ok) {
      // Attach the compiler output (clang stderr) so the UI can show WHY it failed.
      const e = new Error(j.error || 'compileForTarget failed');
      e.log = j.log || '';
      throw e;
    }
    return j.binaryPath;
  }

  // ── runtime ───────────────────────────────────────────────────────────────
  async runSimulation() {
    return _post(this._p('/api/host/run-simulation'), {});
  }
  async stopSimulation() {
    return _post(this._p('/api/host/stop-simulation'), {});
  }
  // Is a local simulation still running in the host-agent? Used to re-attach
  // after a browser reload (the sim + its poller outlive the tab). → {running, pid}
  async simStatus() {
    return _get(this._p('/api/host/sim-status'));
  }
  // mode: 'force' (hold every scan, default) or 'pulse' (apply for one scan,
  // then the logic resumes) — only meaningful for the hot-swap simulation.
  async writeVariable(name, value, mode = 'force') {
    return _post(this._p('/api/host/write-variable'), { name, value: String(value), mode });
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
  /**
   * Report where a model runs (CPU/GPU/split) and GPU VRAM usage. Pass
   * `load:true` to preload the model first so its placement is observable.
   * Returns `{ loaded, processor, gpuPercent, modelSize, modelVram,
   * gpu?:{name, vramTotal, vramUsed} }`. `gpu` is omitted on non-NVIDIA hosts.
   */
  async ollamaRuntime(model, baseUrl, load = false) {
    return _post(this._p('/api/host/ollama-runtime'), { model, baseUrl, load });
  }
  /** Evict a model from memory now (keep_alive:0) to free VRAM. */
  async ollamaUnload(model, baseUrl) {
    return _post(this._p('/api/host/ollama-unload'), { model, baseUrl });
  }
  // Stops the editor-managed `ollama serve` (refuses to touch an externally
  // launched daemon). → { ok, stopped, external, error? }
  async ollamaStop(baseUrl) {
    return _post(this._p('/api/host/ollama-stop'), { baseUrl });
  }

  /**
   * One turn of a tool-calling chat, normalized across providers. The agent
   * loop itself lives on the frontend; this just asks the configured provider
   * for the assistant's next message.
   *
   * payload = { provider, model, apiKey, baseUrl, system, messages, tools,
   *             maxTokens?, temperature? }
   *   messages = [ { role:'user'|'assistant'|'tool', content,
   *                  toolCalls?:[{id,name,arguments}], toolCallId?, name? } ]
   *   tools    = [ { name, description, parameters(JSON Schema) } ]
   * Returns the normalized assistant message:
   *   { role:'assistant', content, toolCalls:[{id,name,arguments}] }
   */
  async aiChat(payload, signal) {
    const j = await _post(this._p('/api/host/ai/chat'), payload, signal);
    if (!j.ok) throw new Error(j.error || 'aiChat failed');
    return j.message;
  }
  /**
   * List the models the provider CURRENTLY serves, so the picker never offers a
   * list frozen at build time. Never throws on a provider-side failure (missing
   * key, daemon down): those come back as `{ ok:true, models:[], error }` so the
   * settings UI can fall back to its built-in suggestions and show why.
   * payload = { provider, apiKey, baseUrl }
   */
  async aiModels(payload) {
    return _post(this._p('/api/host/ai/models'), payload);
  }
  /** Clear the agent exchange log (called on New chat). */
  async aiLogClear() {
    return _post(this._p('/api/host/ai/log-clear'), {});
  }
  /** Snapshot the agent log to a timestamped file; returns { ok, path }. */
  async aiLogSave() {
    return _post(this._p('/api/host/ai/log-save'), {});
  }

  // ── Anthropic account OAuth (Claude Pro/Max sign-in instead of an API key) ──
  /** Begin sign-in: returns { authorizeUrl } to open in a browser. */
  async anthropicOAuthStart() {
    const j = await _post(this._p('/api/host/anthropic-oauth/start'), {});
    if (!j.ok) throw new Error(j.error || 'oauth start failed');
    return j;
  }
  /** Exchange the pasted "code#state" for tokens. Returns { connected }. */
  async anthropicOAuthExchange(code) {
    const j = await _post(this._p('/api/host/anthropic-oauth/exchange'), { code });
    if (!j.ok) throw new Error(j.error || 'oauth exchange failed');
    return j;
  }
  /** Whether a Claude account is currently connected: { connected, expiresAt }. */
  async anthropicOAuthStatus() {
    return _post(this._p('/api/host/anthropic-oauth/status'), {});
  }
  /** Sign out / forget the stored tokens. */
  async anthropicOAuthLogout() {
    return _post(this._p('/api/host/anthropic-oauth/logout'), {});
  }


  // ── Hot-swap (online change) — local simulation ─────────────────────────────
  /**
   * Build the hot-swappable runtime: writes plc.* + variables.json, compiles
   * the loader-host (once) and logic_0.so. Payload = { header, source,
   * variableTable, hal } (same shape as writePlcFiles).
   */
  async hotswapBuild({ header, source, variableTable, hal, hostGlue }) {
    return _post(this._p('/api/host/hotswap/build'), { header, source, variableTable, hal, hostGlue });
  }
  /** Spawn the loader-host with logic_0.so; live variables stream on the usual
   *  simulation-output SSE topic (read from the host-owned /dev/shm mirror). */
  async hotswapRun() {
    return _post(this._p('/api/host/hotswap/run'), {});
  }
  /**
   * Apply an ONLINE change: compile a new logic_<n>.so from the new code and
   * swap it into the running host at a scan boundary (state preserved; rolls
   * back on a bad build). Payload = { header, source } — same PlcState layout.
   */
  async hotswapSwap({ header, source }) {
    return _post(this._p('/api/host/hotswap/swap'), { header, source });
  }
  async hotswapStop() {
    return _post(this._p('/api/host/hotswap/stop'), {});
  }

  // Field hot-swap (deployed KronServer target)
  /** Cross-compile the loader-host (runtime.bin) + logic_0.so for the target board. */
  async hotswapTargetBuild({ header, source, variableTable, hal, hostGlue, boardId }) {
    return _post(this._p('/api/host/hotswap/target-build'), { header, source, variableTable, hal, hostGlue, boardId });
  }
  /** Recompile logic_<n>.so for the target (an online change). */
  async hotswapTargetLogic({ header, source, boardId }) {
    return _post(this._p('/api/host/hotswap/target-logic'), { header, source, boardId });
  }
  /**
   * Upload the hot-swap loader-host runtime.bin + variables.json + the
   * currently-discovered logic_<gen>.so to a deployed KronServer, as one
   * atomic sequence. Deliberately separate from deployToServer (the plain
   * Build & Send path) so the two binary shapes can never be conflated.
   */
  async hotswapTargetDeploy(serverAddr) {
    return _post(this._p('/api/host/hotswap/target-deploy'), { serverAddr });
  }
  /** Push the latest logic.so to a deployed KronServer and trigger a live swap. */
  async hotswapDeploySwap(serverAddr) {
    return _post(this._p('/api/host/hotswap/deploy-swap'), { serverAddr });
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
