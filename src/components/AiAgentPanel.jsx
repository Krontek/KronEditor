import { useState, useRef, useEffect, useCallback } from 'react';
import { host } from '../services/HostClient';

/*
 * AiAgentPanel — PRELIMINARY DESIGN (ön tasarım)
 * ------------------------------------------------------------------
 * VS Code-Copilot-style chat panel that lives as the second tab of the
 * right "Kütüphane" sidebar. The flow it sketches:
 *   1. User introduces a model (provider + model + API key) — inline config.
 *   2. User chats; chooses a mode: Ask / Generate ST / Generate Ladder.
 *   3. Assistant replies; code blocks carry Insert / Copy actions so the
 *      generated ST (or ladder spec) can drop straight into the editor.
 *
 * The model call is STUBBED for now (see sendToModel) — it returns a canned
 * sample so we can evaluate the look & feel before wiring a real backend
 * (host-agent endpoint or a direct provider call). Config is kept in
 * localStorage under "aiAgentConfig"; nothing is sent anywhere yet.
 */

// ── palette (matches the app's dark theme) ──────────────────────────────────
const C = {
  bg: '#252526', panel: '#2d2d2d', input: '#1e1e1e', hover: '#37373d',
  border: '#333', border2: '#3e3e42',
  text: '#d4d4d4', sub: '#aaa', muted: '#999',
  accent: '#007acc', accentBtn: '#0e639c', accentHover: '#1177bb',
  green: '#4ec9b0', user: '#37373d', code: '#1b1b1b',
};

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { id: 'openai', label: 'OpenAI', models: ['gpt-4.1', 'gpt-4o', 'o4-mini'] },
  { id: 'ollama', label: 'Local (Ollama)', models: ['llama3.1', 'qwen2.5-coder', 'deepseek-coder'] },
  { id: 'custom', label: 'Custom endpoint', models: [] },
];

// Curated catalog of local (Ollama) models the user can pull with one click.
// `id` must match the exact Ollama tag so installed-state detection works.
const OLLAMA_CATALOG = [
  { id: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', size: '~1.0 GB', desc: 'Fast, lightweight coding assistant' },
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', size: '~4.7 GB', desc: 'Strong, balanced coding model', recommended: true },
  { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', size: '~9.0 GB', desc: 'Higher quality, needs more RAM' },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', size: '~8.9 GB', desc: 'Strong code generation' },
  { id: 'codellama:7b', label: 'Code Llama 7B', size: '~3.8 GB', desc: "Meta's code model" },
  { id: 'llama3.1:8b', label: 'Llama 3.1 8B', size: '~4.7 GB', desc: 'General-purpose reasoning' },
];

const formatBytes = (n) => {
  if (!n || n <= 0) return '';
  const gb = n / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(n / 1e6).toFixed(0)} MB`;
};

const MODES = [
  { id: 'ask', label: 'Ask', hint: 'Ask anything about your project' },
  { id: 'st', label: 'Generate ST', hint: 'Generate Structured Text' },
  { id: 'ld', label: 'Generate Ladder', hint: 'Generate a Ladder rung spec' },
];

const SUGGESTIONS = {
  ask: ['Explain what this POU does', 'Why is my TON not triggering?', 'List the addressed variables'],
  st: ['Blink an output every 1s', 'Debounce a button into a clean signal', 'Scale 4–20mA into 0–100%'],
  ld: ['Start/Stop motor with seal-in', 'Two-hand safety start', 'Conveyor interlock chain'],
};

const loadConfig = () => {
  try { return JSON.parse(localStorage.getItem('aiAgentConfig') || 'null'); } catch { return null; }
};
const saveConfig = (cfg) => localStorage.setItem('aiAgentConfig', JSON.stringify(cfg));

let _mid = 1;
const newMsg = (role, content, code) => ({ id: _mid++, role, content, code });

// ── stubbed model call (returns a canned sample; real call is a TODO) ───────
function sampleReply(mode, prompt) {
  if (mode === 'st') {
    return {
      content: `Here's a Structured Text snippet for: "${prompt}". Review the variables before inserting.`,
      code: {
        lang: 'st',
        text:
`(* 1 Hz blink on Q0 using a TON *)
blink(IN := NOT blink.Q, PT := T#500ms);
Q0 := blink.Q;`,
      },
    };
  }
  if (mode === 'ld') {
    return {
      content: `A start/stop rung with seal-in for "${prompt}". This is a ladder spec preview — Insert will add it as a new rung.`,
      code: {
        lang: 'ladder',
        text:
`Rung 1:  Motor start/stop (seal-in)
  ──[ Start ]──┬──[ /Stop ]──( Motor )──
   ──[ Motor ]─┘   (seal-in contact)`,
      },
    };
  }
  return { content: `(${prompt}) — once a model is wired, I'll answer here with full project context (active POU, variables, board).`, code: null };
}

export default function AiAgentPanel({ activeItem = null, onInsertCode = null }) {
  const [config, setConfig] = useState(loadConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState(() => config || { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: '', baseUrl: '' });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('st');
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const scrollRef = useRef(null);

  // ── local-model (Ollama) download & setup ────────────────────────────────
  const [cfgTab, setCfgTab] = useState('connect');         // 'connect' | 'download'
  const [ollama, setOllama] = useState({ checked: false, running: false, installed: false, models: [], error: '' });
  const [pulls, setPulls] = useState({});                  // { [model]: { percent, status, done, error } }
  const [setup, setSetup] = useState(null);                // { phase, percent, done, error } | null
  const ollamaBase = (draftCfg.baseUrl && draftCfg.baseUrl.trim()) || 'http://localhost:11434';

  const refreshOllama = useCallback(async () => {
    try {
      const r = await host.ollamaStatus(ollamaBase);
      setOllama({ checked: true, running: !!r.running, installed: !!r.installed, models: r.models || [], error: r.error || '' });
    } catch (e) {
      setOllama({ checked: true, running: false, installed: false, models: [], error: e.message || 'status failed' });
    }
  }, [ollamaBase]);

  // One-click: install (if needed) + start the local Ollama daemon, then refresh.
  const startSetup = async () => {
    setSetup({ phase: 'starting', percent: 0, done: false, error: '' });
    try {
      await host.ollamaSetup(ollamaBase);
    } catch (e) {
      setSetup({ phase: 'failed', percent: 0, done: true, error: e.message || 'setup failed' });
    }
  };

  // Refresh installed-model status whenever the Download tab is opened.
  useEffect(() => {
    if (configOpen && cfgTab === 'download') refreshOllama();
  }, [configOpen, cfgTab, refreshOllama]);

  // Subscribe to pull + setup progress on the host-agent event bus for the panel's lifetime.
  useEffect(() => {
    const close = host.streamEvents((msg) => {
      if (!msg) return;
      if (msg.topic === 'ollama-setup-progress') {
        const d = msg.data || {};
        setSetup({ phase: d.phase || '', percent: d.percent || 0, done: !!d.done, error: d.error || '' });
        if (d.done && !d.error) refreshOllama();   // daemon is up — surface installed models
        return;
      }
      if (msg.topic !== 'ollama-pull-progress') return;
      const d = msg.data || {};
      if (!d.model) return;
      setPulls(p => ({ ...p, [d.model]: { percent: d.percent || 0, status: d.status || '', done: !!d.done, error: d.error || '' } }));
      if (d.done && !d.error) {
        refreshOllama();
        // Auto-connect the freshly downloaded model.
        setConfig(prev => {
          const next = { provider: 'ollama', model: d.model, apiKey: '', baseUrl: ollamaBase };
          saveConfig(next);
          return next;
        });
        setDraftCfg({ provider: 'ollama', model: d.model, apiKey: '', baseUrl: ollamaBase });
      }
    });
    return close;
  }, [refreshOllama, ollamaBase]);

  const installedSet = new Set((ollama.models || []).map(m => m.name));

  const startPull = async (model) => {
    setPulls(p => ({ ...p, [model]: { percent: 0, status: 'starting', done: false, error: '' } }));
    try {
      await host.ollamaPull(model, ollamaBase);
    } catch (e) {
      setPulls(p => ({ ...p, [model]: { percent: 0, status: 'failed', done: true, error: e.message || 'pull failed' } }));
    }
  };

  const useLocalModel = (model) => {
    const next = { provider: 'ollama', model, apiKey: '', baseUrl: ollamaBase };
    saveConfig(next); setConfig(next); setDraftCfg(next); setConfigOpen(false);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const configured = !!(config && config.model && (config.provider === 'ollama' || config.apiKey || config.baseUrl));

  const send = (text) => {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;
    setInput('');
    if (!configured) {
      setMessages(m => [...m, newMsg('user', prompt), newMsg('assistant', 'No model configured yet. Click the ⚙ gear above to introduce a model, then ask again.')]);
      return;
    }
    setMessages(m => [...m, newMsg('user', prompt)]);
    setBusy(true);
    // TODO(ai): replace this stub with a real streaming call —
    //   host-agent POST /api/host/ai/chat  { provider, model, apiKey, baseUrl, mode, prompt, context }
    //   where context = active POU source + variable table. Stream tokens back.
    setTimeout(() => {
      const r = sampleReply(mode, prompt);
      setMessages(m => [...m, newMsg('assistant', r.content, r.code)]);
      setBusy(false);
    }, 450);
  };

  const insert = (code, id) => {
    if (onInsertCode) onInsertCode(code);            // future: drop into the active editor
    else if (navigator.clipboard) navigator.clipboard.writeText(code.text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1400);
  };

  const applyConfig = () => { saveConfig(draftCfg); setConfig(draftCfg); setConfigOpen(false); };

  const providerDef = PROVIDERS.find(p => p.id === draftCfg.provider) || PROVIDERS[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontSize: 12 }}>
      {/* ── header: title + model pill + gear ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 13 }}>🤖</span>
        <span style={{ fontWeight: 600, marginRight: 'auto' }}>AI Agent</span>
        <button
          onClick={() => { setDraftCfg(config || draftCfg); setConfigOpen(o => !o); }}
          title="Model settings"
          style={{ background: configured ? '#1e3a2a' : 'transparent', border: `1px solid ${configured ? '#2e5a3e' : C.border2}`, color: configured ? C.green : C.sub, fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, maxWidth: 150 }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: configured ? C.green : '#777', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{configured ? config.model : 'No model'}</span>
          <span style={{ color: C.muted }}>⚙</span>
        </button>
      </div>

      {/* ── inline model config ───────────────────────────────────────── */}
      {configOpen && (
        <div style={{ padding: 10, background: C.input, borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* tabs: connect an existing model vs. download a local one */}
          <div style={{ display: 'flex', gap: 4, background: C.panel, border: `1px solid ${C.border2}`, borderRadius: 5, padding: 2 }}>
            {[['connect', 'Connect a model'], ['download', 'Download & Setup']].map(([id, lbl]) => (
              <button key={id} onClick={() => setCfgTab(id)}
                style={{ flex: 1, background: cfgTab === id ? C.accentBtn : 'transparent', border: 'none', color: cfgTab === id ? '#fff' : C.sub, fontSize: 11, padding: '4px 6px', borderRadius: 3, cursor: 'pointer' }}>
                {lbl}
              </button>
            ))}
          </div>

          {cfgTab === 'download' ? (
            <OllamaCatalog
              ollama={ollama} pulls={pulls} setup={setup} installedSet={installedSet}
              activeModel={config?.provider === 'ollama' ? config.model : null}
              baseUrl={draftCfg.baseUrl} onBaseUrl={(v) => setDraftCfg(d => ({ ...d, baseUrl: v }))}
              onRefresh={refreshOllama} onSetup={startSetup} onPull={startPull} onUse={useLocalModel}
            />
          ) : (
          <>
          <label style={{ fontSize: 11, color: C.sub }}>Provider</label>
          <select value={draftCfg.provider} onChange={e => setDraftCfg(d => ({ ...d, provider: e.target.value, model: (PROVIDERS.find(p => p.id === e.target.value)?.models[0]) || '' }))}
            style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px' }}>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <label style={{ fontSize: 11, color: C.sub }}>Model</label>
          {providerDef.models.length ? (
            <select value={draftCfg.model} onChange={e => setDraftCfg(d => ({ ...d, model: e.target.value }))}
              style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px' }}>
              {providerDef.models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input value={draftCfg.model} onChange={e => setDraftCfg(d => ({ ...d, model: e.target.value }))} placeholder="model name"
              style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px' }} />
          )}
          {draftCfg.provider !== 'ollama' && (
            <>
              <label style={{ fontSize: 11, color: C.sub }}>API key</label>
              <input type="password" value={draftCfg.apiKey} onChange={e => setDraftCfg(d => ({ ...d, apiKey: e.target.value }))} placeholder="sk-..."
                style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace' }} />
            </>
          )}
          {(draftCfg.provider === 'custom' || draftCfg.provider === 'ollama') && (
            <>
              <label style={{ fontSize: 11, color: C.sub }}>Base URL</label>
              <input value={draftCfg.baseUrl} onChange={e => setDraftCfg(d => ({ ...d, baseUrl: e.target.value }))} placeholder="http://localhost:11434"
                style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace' }} />
            </>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button onClick={applyConfig} style={{ background: C.accentBtn, border: 'none', color: '#fff', fontSize: 12, padding: '5px 12px', cursor: 'pointer', borderRadius: 2 }}>Save</button>
            <button onClick={() => setConfigOpen(false)} style={{ background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 12, padding: '5px 12px', cursor: 'pointer', borderRadius: 2 }}>Cancel</button>
          </div>
          <div style={{ fontSize: 10, color: C.muted }}>Stored locally only. Model calls aren't wired yet — this is a design preview.</div>
          </>
          )}
        </div>
      )}

      {/* ── conversation / empty state ────────────────────────────────── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 ? (
          <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center', color: C.sub }}>
            <div style={{ fontSize: 32 }}>🤖</div>
            <div style={{ fontSize: 13, color: C.text }}>Build PLC logic with an agent</div>
            <div style={{ fontSize: 11, maxWidth: 220 }}>Describe what you want in ST or Ladder. Generated code comes with an Insert button.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 6 }}>
              {SUGGESTIONS[mode].map(s => (
                <button key={s} onClick={() => send(s)}
                  style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 11, padding: '7px 10px', textAlign: 'left', cursor: 'pointer', borderRadius: 4 }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = C.accent}
                  onMouseLeave={e => e.currentTarget.style.borderColor = C.border2}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map(m => <Bubble key={m.id} msg={m} onInsert={insert} copied={copiedId === m.id} />)
        )}
        {busy && <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic' }}>● ● ●  thinking…</div>}
      </div>

      {/* ── input bar ─────────────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: 8, background: C.panel, flexShrink: 0 }}>
        {/* context chip */}
        {activeItem && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, fontSize: 10, color: C.muted }}>
            <span style={{ background: C.input, border: `1px solid ${C.border2}`, padding: '1px 7px', borderRadius: 10 }}>
              📎 {activeItem.name || activeItem.type} <span style={{ color: '#666' }}>· context</span>
            </span>
          </div>
        )}
        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, background: C.input, padding: 6 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={MODES.find(x => x.id === mode)?.hint}
            rows={2}
            style={{ width: '100%', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: C.text, fontSize: 12, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <select value={mode} onChange={e => setMode(e.target.value)}
              style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.sub, fontSize: 11, padding: '2px 4px', borderRadius: 3 }}>
              {MODES.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>↵ send · ⇧↵ newline</span>
            <button onClick={() => send()} disabled={!input.trim() || busy}
              style={{ background: input.trim() && !busy ? C.accentBtn : '#333', border: 'none', color: input.trim() && !busy ? '#fff' : '#777', width: 26, height: 26, borderRadius: 4, cursor: input.trim() && !busy ? 'pointer' : 'default', fontSize: 13 }}>
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── message bubble ──────────────────────────────────────────────────────────
function Bubble({ msg, onInsert, copied }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ fontSize: 10, color: C.muted }}>{isUser ? 'You' : 'Agent'}</div>
      <div style={{ maxWidth: '92%', background: isUser ? C.user : C.input, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '7px 10px', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
        {msg.content}
      </div>
      {msg.code && (
        <div style={{ width: '100%', border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden', marginTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: C.panel, borderBottom: `1px solid ${C.border}` }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: C.green }}>{msg.code.lang}</span>
            <button onClick={() => onInsert(msg.code, msg.id)}
              style={{ marginLeft: 'auto', background: C.accentBtn, border: 'none', color: '#fff', fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer' }}>
              {copied ? '✓ Inserted' : (msg.code.lang === 'ladder' ? '+ Add rung' : '↘ Insert')}
            </button>
          </div>
          <pre style={{ margin: 0, padding: '8px 10px', background: C.code, color: '#cfe8d6', fontSize: 11, fontFamily: 'Consolas, monospace', overflowX: 'auto', lineHeight: 1.4 }}>{msg.code.text}</pre>
        </div>
      )}
    </div>
  );
}

// ── local-model (Ollama) download & setup catalog ───────────────────────────
function OllamaCatalog({ ollama, pulls, setup, installedSet, activeModel, baseUrl, onBaseUrl, onRefresh, onSetup, onPull, onUse }) {
  const settingUp = setup && !setup.done;
  const setupFailed = setup && setup.done && setup.error;
  const setupPhaseLabel = { checking: 'Checking…', downloading: 'Downloading Ollama…', starting: 'Starting daemon…', ready: 'Ready' }[setup?.phase] || setup?.phase || '';
  // Surface any installed models that aren't in the curated catalog too.
  const catalogIds = new Set(OLLAMA_CATALOG.map(m => m.id));
  const extraInstalled = (ollama.models || []).filter(m => !catalogIds.has(m.name));

  const renderRow = (m) => {
    const id = m.id;
    const installed = installedSet.has(id);
    const isActive = activeModel === id;
    const pull = pulls[id];
    const pulling = pull && !pull.done;
    const failed = pull && pull.done && pull.error;

    return (
      <div key={id} style={{ border: `1px solid ${isActive ? '#2e5a3e' : C.border2}`, borderRadius: 5, padding: '7px 8px', display: 'flex', flexDirection: 'column', gap: 5, background: isActive ? '#16271d' : C.panel }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>{m.label || id}</span>
          {m.recommended && <span style={{ fontSize: 9, color: C.accent, border: `1px solid ${C.accent}`, borderRadius: 8, padding: '0 5px' }}>recommended</span>}
          {installed && <span style={{ fontSize: 9, color: C.green }}>● installed</span>}
          <span style={{ marginLeft: 'auto', fontSize: 10, color: C.muted }}>{m.size || formatBytes(m.bytes)}</span>
        </div>
        {m.desc && <div style={{ fontSize: 10, color: C.muted }}>{m.desc}</div>}

        {pulling ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ height: 6, background: C.code, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pull.percent}%`, height: '100%', background: C.accent, transition: 'width .2s' }} />
            </div>
            <div style={{ fontSize: 9, color: C.muted }}>{pull.status} · {pull.percent}%</div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {isActive ? (
              <span style={{ fontSize: 10, color: C.green }}>✓ connected to agent</span>
            ) : installed ? (
              <button onClick={() => onUse(id)}
                style={{ background: '#1e3a2a', border: `1px solid #2e5a3e`, color: C.green, fontSize: 10, padding: '3px 10px', borderRadius: 3, cursor: 'pointer' }}>
                Use this model
              </button>
            ) : (
              <button onClick={() => onPull(id)} disabled={!ollama.running}
                style={{ background: ollama.running ? C.accentBtn : '#333', border: 'none', color: ollama.running ? '#fff' : '#777', fontSize: 10, padding: '3px 10px', borderRadius: 3, cursor: ollama.running ? 'pointer' : 'default' }}>
                ↓ Download
              </button>
            )}
            {failed && <span style={{ fontSize: 9, color: '#e06c75' }}>failed: {pull.error}</span>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* daemon status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ollama.running ? C.green : (ollama.checked ? '#e06c75' : '#777'), flexShrink: 0 }} />
        <span style={{ fontSize: 11, color: C.sub }}>
          {!ollama.checked ? 'Checking Ollama…' : ollama.running ? 'Ollama running' : 'Ollama not reachable'}
        </span>
        <button onClick={onRefresh} title="Refresh"
          style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {ollama.checked && !ollama.running && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: C.code, border: `1px solid ${C.border2}`, borderRadius: 4, padding: '8px' }}>
          <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
            {ollama.installed
              ? 'Ollama is installed but its daemon isn\'t running. Start it to enable downloads.'
              : 'No local Ollama daemon found. Install & start it (no terminal, no sudo) to enable model downloads.'}
          </div>
          {settingUp ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ height: 6, background: C.input, borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${setup.percent}%`, height: '100%', background: C.accent, transition: 'width .2s' }} />
              </div>
              <div style={{ fontSize: 9, color: C.muted }}>{setupPhaseLabel}{setup.phase === 'downloading' ? ` · ${setup.percent}%` : ''}</div>
            </div>
          ) : (
            <button onClick={onSetup}
              style={{ alignSelf: 'flex-start', background: C.accentBtn, border: 'none', color: '#fff', fontSize: 11, padding: '4px 12px', borderRadius: 3, cursor: 'pointer' }}>
              {ollama.installed ? '▶ Start Ollama' : '↓ Install & Start Ollama'}
            </button>
          )}
          {setupFailed && <span style={{ fontSize: 9, color: '#e06c75' }}>setup failed: {setup.error}</span>}
        </div>
      )}

      {/* base URL */}
      <label style={{ fontSize: 11, color: C.sub }}>Ollama host</label>
      <input value={baseUrl || ''} onChange={e => onBaseUrl(e.target.value)} placeholder="http://localhost:11434"
        style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace' }} />

      {/* catalog */}
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: C.muted, marginTop: 2 }}>Recommended models</div>
      {OLLAMA_CATALOG.map(renderRow)}

      {extraInstalled.length > 0 && (
        <>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: C.muted, marginTop: 2 }}>Other installed</div>
          {extraInstalled.map(m => renderRow({ id: m.name, label: m.name, bytes: m.size }))}
        </>
      )}

      <div style={{ fontSize: 10, color: C.muted }}>Downloads run on the host machine and connect automatically when finished.</div>
    </div>
  );
}
