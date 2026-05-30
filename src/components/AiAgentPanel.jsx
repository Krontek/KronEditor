import { useState, useRef, useEffect, useCallback } from 'react';
import { host } from '../services/HostClient';
import { TOOL_DEFS, applyToolCall, buildProjectOverview } from '../services/agentTools';

/*
 * AiAgentPanel — project-editing AI agent.
 * ------------------------------------------------------------------
 * Lives as the second tab of the right "Kütüphane" sidebar. It is a real
 * tool-calling agent, not a chat stub: it can create/rename/delete POUs,
 * rewrite ST code, and add/update/remove variables (local + global) across the
 * whole project. The board is read-only context — the agent never changes
 * hardware.
 *
 * Architecture:
 *   - The model call is provider-agnostic and goes through the host-agent
 *     (host.aiChat → POST /api/host/ai/chat), so Anthropic / OpenAI / Ollama /
 *     custom all expose the same tool-calling shape.
 *   - The AGENT LOOP runs here on the frontend because this is where the
 *     project lives. Each model turn may return tool calls; read tools run
 *     automatically, write tools are dry-run into a proposed structure and
 *     shown as a DIFF the user must approve before it touches the project
 *     ("diff göster, onayla"). Tool executors live in services/agentTools.js.
 *   - Config (provider/model/apiKey/baseUrl) persists in localStorage
 *     "aiAgentConfig"; the Ollama download/setup tab is unchanged.
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

// Binary GiB — matches how nvidia-smi / GPUs report VRAM (a "6 GB" card ≈ 6.0).
const toGiB = (n) => (n && n > 0 ? n / (1024 ** 3) : 0);

const SUGGESTIONS = [
  'Create an ST program "Blinker" that toggles an output every second',
  'Add a global BOOL motor_on addressed at %MX0.0',
  'Add a debounce timer to the active POU and use it',
  'Explain what this POU does and list its variables',
];

const loadConfig = () => {
  try { return JSON.parse(localStorage.getItem('aiAgentConfig') || 'null'); } catch { return null; }
};
const saveConfig = (cfg) => localStorage.setItem('aiAgentConfig', JSON.stringify(cfg));

// Conversation persistence — the panel only mounts while the "agent" tab is
// open, so without this the chat is lost on every tab switch / reload.
const CONVO_KEY = 'aiAgentConversation';
const loadConvo = () => {
  try { return JSON.parse(localStorage.getItem(CONVO_KEY) || 'null'); } catch { return null; }
};
const saveConvo = (messages, convo) => {
  try { localStorage.setItem(CONVO_KEY, JSON.stringify({ messages, convo })); } catch { /* quota */ }
};

// Strip model chat-template / special tokens that some local models leak into
// their output (e.g. <|im_start|>, <|im_end|>, <|endoftext|>) plus the
// <tool_call>/<tool_response> wrapper tags some models emit (the inner JSON, if
// any, is kept so it can still be parsed into a tool call).
const stripSpecialTokens = (s) => (s || '')
  .replace(/<\|[a-z_]+\|>/gi, '')
  .replace(/<\/?tool_(?:call|response|result|use)>/gi, '')
  .trim();

// Repair the single most common LLM JSON malformation: an object written with
// square brackets. Models sometimes emit `[ "key": val ]` (array syntax) where
// they meant `{ "key": val }` (object) — e.g. set_ladder's `rungs: [["outputs":…]]`.
// Walk the string (ignoring brackets inside strings); a `[` whose first non-space
// content is a `"…":` key is rewritten to `{` and its matching `]` to `}`.
function repairJsonBrackets(s) {
  let out = '';
  let inStr = false, esc = false;
  const stack = []; // { converted } per open bracket
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '[') {
      // Look ahead: skip whitespace; is the next token a "string" followed by ':'?
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      let looksLikeObject = false;
      if (s[j] === '"') {
        let k = j + 1, e2 = false;
        for (; k < s.length; k++) { const c = s[k]; if (e2) { e2 = false; } else if (c === '\\') { e2 = true; } else if (c === '"') break; }
        let m = k + 1;
        while (m < s.length && /\s/.test(s[m])) m++;
        if (s[m] === ':') looksLikeObject = true;
      }
      stack.push({ converted: looksLikeObject });
      out += looksLikeObject ? '{' : '[';
      continue;
    }
    if (ch === '{') { stack.push({ converted: false, brace: true }); out += '{'; continue; }
    if (ch === ']') { const f = stack.pop(); out += (f && f.converted) ? '}' : ']'; continue; }
    if (ch === '}') { stack.pop(); out += '}'; continue; }
    out += ch;
  }
  return out;
}

let _mid = 1;
const nextId = () => _mid++;

// Safety cap so a misbehaving model can't loop on tool calls forever.
const MAX_AGENT_TURNS = 16;

const KNOWN_TOOLS = new Set(TOOL_DEFS.map((t) => t.name));

// Scan a string for every TOP-LEVEL balanced {...} JSON object, ignoring braces
// inside strings. Handles models that emit several tool-call objects back to
// back (not wrapped in an array) plus trailing prose like "Summary: …".
function findJsonObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { if (depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } } }
  }
  return out;
}

// Some models (especially local ones) emit tool calls as plain TEXT — one or
// MORE JSON objects like { "name": "...", "arguments": {...} } — instead of the
// provider's structured tool_calls field. Recover all of them so local models
// stay usable. Returns a normalized toolCalls array, or null if none found.
function extractInlineToolCalls(content) {
  if (!content) return null;
  // Strip code-fence markers (keep their contents) so fenced blocks are scanned.
  const text = content.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const candidates = [];
  // A whole-array form first: [ {…}, {…} ].
  try {
    const arr = JSON.parse(text.trim());
    if (Array.isArray(arr)) candidates.push(...arr);
    else if (arr && typeof arr === 'object') candidates.push(arr);
  } catch { /* not a clean array/object — scan for embedded objects */ }
  if (candidates.length === 0) {
    for (const raw of findJsonObjects(text)) {
      try { candidates.push(JSON.parse(raw)); }
      catch {
        // Fallback: repair the array-vs-object bracket malformation and retry
        // (e.g. set_ladder's `rungs: [["outputs":…]]` → `[{"outputs":…}]`).
        try { candidates.push(JSON.parse(repairJsonBrackets(raw))); } catch { /* skip non-JSON */ }
      }
    }
  }
  const calls = [];
  candidates.forEach((o, i) => {
    if (o && typeof o === 'object' && typeof o.name === 'string' && KNOWN_TOOLS.has(o.name)) {
      const args = o.arguments ?? o.parameters ?? o.args ?? {};
      calls.push({ id: `inline_${i}`, name: o.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
    }
  });
  return calls.length ? calls : null;
}

// Parse a tool call's arguments (string or object) defensively.
function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { __parseError: true }; }
}

// Build the `tool` message we feed back to the model for one executed step.
function toolResultMessage(step) {
  const { tc, res, outcome } = step;
  let content;
  if (!res || !res.ok) content = `ERROR: ${res?.error || 'tool failed'}`;
  else if (res.mutation) {
    content = outcome === 'rejected'
      ? `REJECTED by the user. Do not retry this exact change unless they ask.`
      : `APPLIED: ${res.summary}`;
  } else {
    content = JSON.stringify(res.result);
  }
  return { role: 'tool', toolCallId: tc.id, name: tc.name, content };
}

// POU names a proposal touched — used to reload the open editor after apply.
function affectedPOUs(steps) {
  const names = new Set();
  for (const s of steps) {
    if (!(s.res?.mutation && s.res.ok)) continue;
    const a = s.args || {};
    if (a.pou) names.add(a.pou);
    if (a.name && (s.tc.name === 'set_st_code' || s.tc.name.endsWith('_pou'))) names.add(a.name);
    if (a.newName) names.add(a.newName);
  }
  return [...names];
}

// System prompt: the agent's role + project conventions + a COMPACT project map
// (POU names + globals only — small, so it fits a modest context window and the
// model always sees every POU). Details come on demand via read_pou /
// get_project_overview, not by embedding the full overview each turn.
function buildSystemPrompt(projectStructure, board, activeItem) {
  const overview = buildProjectOverview(projectStructure, board);
  const active = activeItem ? `${activeItem.name} (${activeItem.type})` : 'none';
  const pous = overview.pous.map((p) => `${p.name}[${p.language}${p.returnType ? ' ' + p.returnType : ''}]`).join(', ') || '(none)';
  const globals = overview.globalVariables.map((g) => g.name).join(', ') || '(none)';
  const dts = overview.dataTypes.map((d) => d.name).join(', ');
  return [
    'You are the embedded engineering agent for KronEditor, an IEC 61131-3 PLC editor.',
    'You edit the project by calling tools: create/rename/delete POUs, rewrite Structured Text, set ladder, and add/update/remove variables (local + global).',
    '',
    'Rules:',
    '- The selected board is READ-ONLY context. Never change hardware.',
    '- All generated code, names and comments in English. Names must be IEC identifiers (letters/digits/underscore, no spaces, no leading digit).',
    '- Structured Text must be valid IEC 61131-3: := assign; AND/OR/NOT logical; BAND/BOR/BXOR/BNOT bitwise; time literals like T#500ms.',
    '- Before using a variable in ST, add it with add_variable (in the SAME response).',
    '- Make the smallest change that satisfies the request; prefer editing an existing POU over creating new ones unless asked. delete_pou/remove_variable only when explicitly asked.',
    '- Finish the WHOLE request in your tool calls before replying — if asked to create a POU AND write its code, emit create_pou THEN set_st_code/set_ladder AND the add_variable calls. NEVER stop to ask the user to "provide the code" or hand it back; you write it.',
    '- set_st_code replaces the WHOLE body and takes ONLY body statements — NO PROGRAM/VAR/END_VAR/END_PROGRAM wrapper (variables go via add_variable). set_ladder (contacts+coils only) replaces all rungs.',
    '- PLC logic runs ONCE per scan, cyclically — NEVER write unbounded loops (no WHILE TRUE; it hangs the PLC). For timing use a TON across scans, e.g. `pulse(IN := NOT pulse.Q, PT := T#1s); IF pulse.Q THEN out := NOT out; END_IF`.',
    '- Function blocks (TON, TOF, TP, CTU, CTD, R_TRIG, user FBs) are INSTANCES, not functions. For each you must: (1) add_variable with type = the FB name itself (e.g. type "TON" — NOT "TIME"/"BOOL"); (2) CALL it as `name(IN := …, PT := …);`; (3) read its outputs as `name.Q`, `name.ET`. NEVER write `name := TON(…)` — assigning an FB call is invalid IEC and will not compile.',
    '- A correct TON blink is EXACTLY: declare `blink : TON;` (add_variable type TON) and `led : BOOL`, then body `blink(IN := NOT blink.Q, PT := T#500ms); IF blink.Q THEN led := NOT led; END_IF;`. Do not also toggle led outside the IF.',
    '- CRITICAL: you change the project ONLY by emitting tool calls. NEVER write code in prose and claim it is done; NEVER output "APPLIED:" or "I have set the code" — the SYSTEM applies + confirms. To write code into a POU you MUST call set_st_code/set_ladder.',
    '- Every change is shown as a diff the user approves/rejects; if rejected, adapt. When done, reply with a short summary in the user\'s language.',
    '- Use read_pou for a POU\'s code+variables, get_project_overview for full detail, read_live_variables (while running) to diagnose before a fix.',
    '',
    `Board: ${board || 'none'}. Currently open POU: ${active}.`,
    `POUs (${overview.pous.length}): ${pous}.`,
    `Global variables: ${globals}.`,
    dts ? `Data types: ${dts}.` : '',
  ].filter(Boolean).join('\n');
}

export default function AiAgentPanel({
  activeItem = null,
  projectStructure = null,
  setProjectStructure = null,
  selectedBoard = null,
  liveVariables = null,        // live values from the running sim/PLC (for read_live_variables)
  onApplied = null,            // (pouNames[]) → reload the open editor after a commit
  onHotSwap = null,            // (pouNames[]) → push an online change while running
  hotSwapActive = false,       // a live hot-swap session is running
  onStartHotSwap = null,       // () → build+run a hot-swap session (online change)
  onStopHotSwap = null,        // () → stop the hot-swap session
}) {
  const [config, setConfig] = useState(loadConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState(() => config || { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: '', baseUrl: '' });
  // Restore the persisted conversation. A proposal left mid-approval is marked
  // not-applied on restore (it was never committed). _mid is advanced past the
  // restored ids so new view items don't collide.
  const _restored = useRef(loadConvo());
  const [messages, setMessages] = useState(() =>
    (_restored.current?.messages || []).map((m) =>
      m.role === 'proposal' && m.status === 'pending' ? { ...m, status: 'rejected' } : m)
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);          // waiting on a model turn
  const [pending, setPending] = useState(null);     // a proposal awaiting approve/reject
  const scrollRef = useRef(null);
  if (_restored.current?.messages?.length) {
    _mid = Math.max(_mid, ...(_restored.current.messages.map((m) => (m.id || 0) + 1)));
    _restored.current = { ..._restored.current, messages: null }; // bump once
  }

  // The canonical provider message list (what we send to host.aiChat each turn),
  // and the working project structure the agent is mutating. Kept in refs so the
  // async loop always sees the latest without re-render races.
  const convoRef = useRef((loadConvo() || {}).convo || []);
  const workingRef = useRef(projectStructure);
  const psRef = useRef(projectStructure);
  useEffect(() => { psRef.current = projectStructure; }, [projectStructure]);

  // ── local-model (Ollama) download & setup ────────────────────────────────
  const [cfgTab, setCfgTab] = useState('connect');         // 'connect' | 'download'
  const [ollama, setOllama] = useState({ checked: false, running: false, installed: false, models: [], error: '' });
  const [pulls, setPulls] = useState({});                  // { [model]: { percent, status, done, error } }
  const [setup, setSetup] = useState(null);                // { phase, percent, done, error } | null
  const [runtime, setRuntime] = useState(null);            // active model placement: { loaded, processor, gpu, ... }
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
    saveConfig(next); setConfig(next); setDraftCfg(next);
    // Keep the panel open so the runtime placement (CPU/GPU + VRAM) is visible.
    setRuntime(null);
  };

  // Evict the model from VRAM now (keep_alive:0). The 4s runtime poll then shows
  // it as idle/not-loaded.
  const unloadLocalModel = async (model) => {
    try {
      await host.ollamaUnload(model, ollamaBase);
      setRuntime({ loaded: false });
    } catch (e) {
      setOllama((o) => ({ ...o, error: e.message || 'unload failed' }));
    }
  };

  // When an Ollama model is active, make sure we know whether the daemon is up
  // (the Download-tab effect only refreshes while that tab is open).
  const activeOllamaModel = config?.provider === 'ollama' ? config.model : null;
  useEffect(() => {
    if (activeOllamaModel && !ollama.checked) refreshOllama();
  }, [activeOllamaModel, ollama.checked, refreshOllama]);

  // Poll the active local model's runtime placement (CPU/GPU split + GPU VRAM)
  // so both the header badge and the Download tab reflect where it's running.
  // The Download tab preloads it (load:true) so /api/ps can report placement
  // immediately; the passive header poll never forces a load into memory.
  useEffect(() => {
    if (!activeOllamaModel || !ollama.running) {
      setRuntime(null);
      return;
    }
    let alive = true;
    const forceLoad = configOpen && cfgTab === 'download';
    const tick = async (load) => {
      try {
        const r = await host.ollamaRuntime(activeOllamaModel, ollamaBase, load);
        if (alive) setRuntime(r);
      } catch { if (alive) setRuntime(null); }
    };
    tick(forceLoad);
    const iv = setInterval(() => tick(false), 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [configOpen, cfgTab, activeOllamaModel, ollama.running, ollamaBase]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  // Persist the conversation (view + API history) so it survives the panel
  // unmounting on a tab switch and a full reload. convoRef is updated alongside
  // messages each turn, so saving on messages change captures both.
  useEffect(() => {
    saveConvo(messages, convoRef.current);
  }, [messages]);

  const configured = !!(config && config.model && (config.provider === 'ollama' || config.apiKey || config.baseUrl));

  const pushView = (item) => setMessages((m) => [...m, { id: nextId(), ...item }]);
  const setViewStatus = (viewId, status) =>
    setMessages((m) => m.map((x) => (x.id === viewId ? { ...x, status } : x)));

  // One model turn: ask the provider for the assistant's next message, run any
  // read tools automatically, and surface write tools as a proposal to approve.
  const runTurn = useCallback(async (apiMessages, turn) => {
    if (turn > MAX_AGENT_TURNS) {
      pushView({ role: 'note', text: 'Stopped — too many tool iterations. Ask me to continue if needed.' });
      return;
    }
    setBusy(true);
    let assistant;
    try {
      assistant = await host.aiChat({
        provider: config.provider, model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
        system: buildSystemPrompt(psRef.current, selectedBoard, activeItem),
        messages: apiMessages,
        tools: TOOL_DEFS,
      });
    } catch (e) {
      setBusy(false);
      pushView({ role: 'note', text: `Error: ${e.message}` });
      return;
    }
    setBusy(false);

    let calls = assistant.toolCalls || [];
    let assistantText = stripSpecialTokens(assistant.content || '');
    // Fallback: a model that wrote the tool call as text instead of using the
    // structured field. Promote it to a real call and don't show it as prose.
    if (calls.length === 0) {
      const inline = extractInlineToolCalls(assistantText);
      if (inline) { calls = inline; assistantText = ''; }
    }
    // Normalize every tool call's arguments to a valid OBJECT before it enters
    // the conversation. Otherwise a string/truncated-JSON argument (common from
    // weak local models, or from the inline fallback) gets echoed back to the
    // provider next turn and is rejected (e.g. Ollama "Value looks like object,
    // but can't find closing '}' symbol" → HTTP 400).
    calls = calls.map((c) => {
      const a = parseArgs(c.arguments);
      return { ...c, arguments: a && a.__parseError ? {} : a };
    });
    const assistantMsg = { role: 'assistant', content: assistantText, toolCalls: calls };
    convoRef.current = [...apiMessages, assistantMsg];
    if (assistantText && assistantText.trim()) pushView({ role: 'assistant', text: assistantText });

    if (calls.length === 0) return; // final answer, loop ends

    // Dry-run every call in order, chaining mutations through a working copy so
    // composed diffs (e.g. add_variable then set_st_code) are computed correctly.
    let working = workingRef.current;
    const steps = [];
    for (const tc of calls) {
      const args = parseArgs(tc.arguments);
      if (args.__parseError) { steps.push({ tc, args: {}, res: { ok: false, error: 'arguments were not valid JSON' } }); continue; }
      if (tc.name === 'get_project_overview') args.__board = selectedBoard;
      if (tc.name === 'read_live_variables') args.__live = liveVariables;
      const res = applyToolCall(working, tc.name, args);
      if (res.mutation && res.ok) working = res.next;
      steps.push({ tc, args, res });
    }

    const hasMutations = steps.some((s) => s.res?.mutation && s.res.ok);
    if (!hasMutations) {
      // Reads / errors only — feed results back and keep going automatically.
      const toolMsgs = steps.map(toolResultMessage);
      runTurn([...convoRef.current, ...toolMsgs], turn + 1);
      return;
    }

    // Pause for approval. dryStruct is the fully-composed result of this turn.
    const viewId = nextId();
    setMessages((m) => [...m, { id: viewId, role: 'proposal', steps, status: 'pending' }]);
    setPending({ steps, dryStruct: working, viewId, turn });
  }, [config, selectedBoard, activeItem, liveVariables]);

  const send = (text) => {
    const prompt = (text ?? input).trim();
    if (!prompt || busy || pending) return;
    setInput('');
    if (!configured) {
      pushView({ role: 'user', text: prompt });
      pushView({ role: 'note', text: 'No model configured yet. Click the ⚙ gear above to connect a model, then ask again.' });
      return;
    }
    pushView({ role: 'user', text: prompt });
    // Start a fresh agent run from the latest committed project state.
    workingRef.current = psRef.current;
    const apiMessages = [...convoRef.current, { role: 'user', content: prompt }];
    runTurn(apiMessages, 0);
  };

  const resolvePending = (approved) => {
    if (!pending) return;
    const { steps, dryStruct, viewId, turn } = pending;
    if (approved) {
      setProjectStructure && setProjectStructure(dryStruct);
      workingRef.current = dryStruct;
      const touched = affectedPOUs(steps);
      onApplied && onApplied(touched);
      // If a hot-swap session is live, push the change online (App decides
      // whether a swap is possible or a cold restart is needed).
      onHotSwap && onHotSwap(touched);
    }
    setViewStatus(viewId, approved ? 'approved' : 'rejected');
    const toolMsgs = steps.map((s) => toolResultMessage({ ...s, outcome: approved ? 'applied' : 'rejected' }));
    setPending(null);
    runTurn([...convoRef.current, ...toolMsgs], turn + 1);
  };

  const resetChat = () => {
    if (busy) return;
    convoRef.current = [];
    setPending(null);
    setMessages([]);
    try { localStorage.removeItem(CONVO_KEY); } catch { /* ignore */ }
    host.aiLogClear().catch(() => {}); // start a fresh agent log too
  };

  // Snapshot the host-agent's exchange log to a timestamped file.
  const saveLog = async () => {
    try {
      const r = await host.aiLogSave();
      pushView({ role: 'note', text: `Log saved: ${r.path}` });
    } catch (e) {
      pushView({ role: 'note', text: `Log save failed: ${e.message || e}` });
    }
  };

  const applyConfig = () => { saveConfig(draftCfg); setConfig(draftCfg); setConfigOpen(false); };

  const providerDef = PROVIDERS.find(p => p.id === draftCfg.provider) || PROVIDERS[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontSize: 12 }}>
      {/* ── header: title + model pill + gear ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 13 }}>🤖</span>
        <span style={{ fontWeight: 600, marginRight: 'auto' }}>AI Agent</span>
        {(onStartHotSwap || onStopHotSwap) && (
          <button
            onClick={() => { if (hotSwapActive) { onStopHotSwap && onStopHotSwap(); } else { onStartHotSwap && onStartHotSwap(); } }}
            title={hotSwapActive ? 'Live online-change session running — approved edits hot-swap into the running PLC. Click to stop.' : 'Go live: build+run a hot-swap session so approved edits apply online (no restart).'}
            style={{ background: hotSwapActive ? '#16271d' : 'transparent', border: `1px solid ${hotSwapActive ? '#2e5a3e' : C.border2}`, color: hotSwapActive ? C.green : C.sub, fontSize: 10, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {hotSwapActive ? '⚡ Live' : 'Go live'}
          </button>
        )}
        {activeOllamaModel && <RuntimeBadge rt={runtime} />}
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
              ollama={ollama} pulls={pulls} setup={setup} runtime={runtime} installedSet={installedSet}
              activeModel={config?.provider === 'ollama' ? config.model : null}
              baseUrl={draftCfg.baseUrl} onBaseUrl={(v) => setDraftCfg(d => ({ ...d, baseUrl: v }))}
              onRefresh={refreshOllama} onSetup={startSetup} onPull={startPull} onUse={useLocalModel} onUnload={unloadLocalModel}
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
          <div style={{ fontSize: 10, color: C.muted }}>Stored locally only. The agent edits your project through reviewable diffs you approve.</div>
          </>
          )}
        </div>
      )}

      {/* ── conversation / empty state ────────────────────────────────── */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 ? (
          <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center', color: C.sub }}>
            <div style={{ fontSize: 32 }}>🤖</div>
            <div style={{ fontSize: 13, color: C.text }}>Edit your project with an agent</div>
            <div style={{ fontSize: 11, maxWidth: 230 }}>Ask in plain language. The agent proposes changes to POUs, ST code and variables as diffs you approve before they apply.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 6 }}>
              {SUGGESTIONS.map(s => (
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
          messages.map(m => (
            m.role === 'proposal'
              ? <ProposalCard key={m.id} steps={m.steps} status={m.status}
                  onApprove={() => resolvePending(true)} onReject={() => resolvePending(false)} />
              : <Bubble key={m.id} msg={m} />
          ))
        )}
        {busy && <div style={{ color: C.muted, fontSize: 11, fontStyle: 'italic' }}>● ● ●  thinking…</div>}
      </div>

      {/* ── input bar ─────────────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: 8, background: C.panel, flexShrink: 0 }}>
        {/* context chip + new-chat */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, fontSize: 10, color: C.muted }}>
          {activeItem && (
            <span style={{ background: C.input, border: `1px solid ${C.border2}`, padding: '1px 7px', borderRadius: 10 }}>
              📎 {activeItem.name || activeItem.type} <span style={{ color: '#666' }}>· context</span>
            </span>
          )}
          <button onClick={saveLog} title="Save the model-exchange log to a timestamped file"
            style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: 'pointer' }}>
            ⤓ Save log
          </button>
          {messages.length > 0 && (
            <button onClick={resetChat} disabled={busy} title="New chat (also clears the agent log)"
              style={{ background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: busy ? 'default' : 'pointer' }}>
              ＋ New chat
            </button>
          )}
        </div>
        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, background: C.input, padding: 6, opacity: pending ? 0.55 : 1 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={pending ? 'Approve or reject the proposed changes first…' : 'Describe the change you want…'}
            rows={2}
            disabled={!!pending}
            style={{ width: '100%', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: C.text, fontSize: 12, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>↵ send · ⇧↵ newline</span>
            <button onClick={() => send()} disabled={!input.trim() || busy || !!pending}
              style={{ background: input.trim() && !busy && !pending ? C.accentBtn : '#333', border: 'none', color: input.trim() && !busy && !pending ? '#fff' : '#777', width: 26, height: 26, borderRadius: 4, cursor: input.trim() && !busy && !pending ? 'pointer' : 'default', fontSize: 13 }}>
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── message bubble (user / assistant / note) ─────────────────────────────────
function Bubble({ msg }) {
  if (msg.role === 'note') {
    return <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic', textAlign: 'center' }}>{msg.text}</div>;
  }
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ fontSize: 10, color: C.muted }}>{isUser ? 'You' : 'Agent'}</div>
      <div style={{ maxWidth: '92%', background: isUser ? C.user : C.input, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '7px 10px', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
        {msg.text}
      </div>
    </div>
  );
}

// ── proposal card: the diffs for one assistant turn, gated by approve/reject ──
const TOOL_ICON = {
  create_pou: '📄', rename_pou: '✏️', delete_pou: '🗑', set_st_code: '✏️',
  add_variable: '➕', update_variable: '✏️', remove_variable: '➖', set_ladder: '🪜',
};

function DiffBlock({ lines }) {
  if (!lines || lines.length === 0) return null;
  const bg = { add: 'rgba(78,201,176,0.12)', del: 'rgba(224,108,117,0.12)', ctx: 'transparent' };
  const fg = { add: '#9bdcc7', del: '#e0a0a6', ctx: C.sub };
  const sign = { add: '+', del: '−', ctx: ' ' };
  return (
    <pre style={{ margin: 0, padding: '6px 8px', background: C.code, borderRadius: 4, maxHeight: 240, overflow: 'auto', fontSize: 11, fontFamily: 'Consolas, monospace', lineHeight: 1.4 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ background: bg[l.type], color: fg[l.type], whiteSpace: 'pre-wrap' }}>
          <span style={{ color: C.muted, userSelect: 'none' }}>{sign[l.type]} </span>{l.text}
        </div>
      ))}
    </pre>
  );
}

function ProposalCard({ steps, status, onApprove, onReject }) {
  const writes = steps.filter(s => s.res?.mutation && s.res.ok);
  const errors = steps.filter(s => !s.res?.ok);
  const statusBadge = status === 'approved'
    ? { fg: C.green, label: '✓ applied' }
    : status === 'rejected' ? { fg: '#e06c75', label: '✕ rejected' } : null;

  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, background: C.panel, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 9px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: C.text }}>Proposed changes</span>
        <span style={{ fontSize: 10, color: C.muted }}>{writes.length} change{writes.length === 1 ? '' : 's'}</span>
        {statusBadge && <span style={{ marginLeft: 'auto', fontSize: 10, color: statusBadge.fg }}>{statusBadge.label}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 9 }}>
        {writes.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, color: C.text }}>
              <span style={{ marginRight: 5 }}>{TOOL_ICON[s.tc.name] || '•'}</span>{s.res.summary}
            </div>
            <DiffBlock lines={s.res.diff?.lines} />
          </div>
        ))}
        {errors.map((s, i) => (
          <div key={`e${i}`} style={{ fontSize: 10, color: '#e06c75' }}>
            ⚠ {s.tc.name}: {s.res.error}
          </div>
        ))}
      </div>

      {status === 'pending' && (
        <div style={{ display: 'flex', gap: 6, padding: '8px 9px', borderTop: `1px solid ${C.border}` }}>
          <button onClick={onApprove}
            style={{ flex: 1, background: '#1e3a2a', border: '1px solid #2e5a3e', color: C.green, fontSize: 12, padding: '5px 0', borderRadius: 3, cursor: 'pointer' }}>
            ✓ Approve & apply
          </button>
          <button onClick={onReject}
            style={{ flex: 1, background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 12, padding: '5px 0', borderRadius: 3, cursor: 'pointer' }}>
            ✕ Reject
          </button>
        </div>
      )}
    </div>
  );
}

// ── local-model (Ollama) download & setup catalog ───────────────────────────
function OllamaCatalog({ ollama, pulls, setup, runtime, installedSet, activeModel, baseUrl, onBaseUrl, onRefresh, onSetup, onPull, onUse, onUnload }) {
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
        ) : isActive ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: C.green }}>✓ connected to agent</span>
              {runtime && runtime.loaded && onUnload && (
                <button onClick={() => onUnload(id)} title="Evict the model from VRAM now (frees GPU memory)"
                  style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 9, padding: '1px 7px', borderRadius: 8, cursor: 'pointer' }}>
                  ⏏ Unload
                </button>
              )}
            </div>
            <RuntimeStats rt={runtime} />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {installed ? (
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

// ── runtime placement: CPU/GPU badge + live GPU VRAM bar ─────────────────────
// Compact header badge: where the active local model is running (GPU/CPU) plus
// the live usage split / VRAM footprint. Renders nothing until the model is
// actually loaded into memory.
function RuntimeBadge({ rt }) {
  if (!rt) {
    return <span style={{ fontSize: 9, color: C.muted, whiteSpace: 'nowrap' }}>⟳ probing…</span>;
  }
  if (!rt.loaded) {
    return <span style={{ fontSize: 9, color: C.muted, whiteSpace: 'nowrap' }}>idle</span>;
  }

  const proc = rt.processor || 'GPU';
  const usedG = toGiB(rt.modelVram);
  const totG = rt.gpu ? toGiB(rt.gpu.vramTotal) : 0;
  const vramPct = totG > 0 ? Math.round((usedG / totG) * 100) : 0;

  const badge = {
    GPU:       { bg: '#16271d', bd: '#2e5a3e', fg: C.green,
                 label: totG > 0 ? `⚡ GPU ${vramPct}%` : '⚡ GPU' },
    'GPU/CPU': { bg: '#2a2410', bd: '#5a4e2e', fg: '#d6c34e',
                 label: `⚡ GPU ${rt.gpuPercent}% · CPU ${100 - rt.gpuPercent}%` },
    CPU:       { bg: '#1b2330', bd: '#2e3e5a', fg: '#6ab0ff', label: '🖥 CPU' },
  }[proc] || { bg: C.panel, bd: C.border2, fg: C.muted, label: proc };

  const title = [
    `Running on ${proc}`,
    rt.gpu ? `GPU: ${rt.gpu.name}` : null,
    totG > 0 ? `VRAM: ${usedG.toFixed(1)} / ${totG.toFixed(1)} GB (${vramPct}%)`
             : usedG > 0 ? `${usedG.toFixed(1)} GB resident in VRAM` : null,
  ].filter(Boolean).join('\n');

  return (
    <span title={title}
      style={{ fontSize: 9, fontWeight: 600, color: badge.fg, background: badge.bg, border: `1px solid ${badge.bd}`, borderRadius: 8, padding: '1px 7px', whiteSpace: 'nowrap' }}>
      {badge.label}
    </span>
  );
}

function RuntimeStats({ rt }) {
  if (!rt) {
    return <span style={{ fontSize: 10, color: C.muted }}>⟳ probing runtime…</span>;
  }
  if (!rt.loaded) {
    return <span style={{ fontSize: 10, color: C.muted }}>idle · not loaded into memory</span>;
  }

  const proc = rt.processor || 'GPU';
  const badge = {
    GPU:       { bg: '#16271d', bd: '#2e5a3e', fg: C.green,   label: '⚡ GPU' },
    'GPU/CPU': { bg: '#2a2410', bd: '#5a4e2e', fg: '#d6c34e', label: `⚡ GPU ${rt.gpuPercent}% · CPU ${100 - rt.gpuPercent}%` },
    CPU:       { bg: '#1b2330', bd: '#2e3e5a', fg: '#6ab0ff', label: '🖥 CPU' },
  }[proc] || { bg: C.panel, bd: C.border2, fg: C.muted, label: proc };

  // Bar shows this model's VRAM footprint against the card's capacity.
  const gpu = rt.gpu;
  const usedG = toGiB(rt.modelVram);
  const totG = gpu ? toGiB(gpu.vramTotal) : 0;
  const ratio = totG > 0 ? usedG / totG : 0;
  const barColor = ratio > 0.9 ? '#e06c75' : ratio > 0.7 ? '#d6c34e' : C.green;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: badge.fg, background: badge.bg, border: `1px solid ${badge.bd}`, borderRadius: 8, padding: '1px 8px', whiteSpace: 'nowrap' }}>
          {badge.label}
        </span>
        {gpu && (
          <span style={{ fontSize: 9, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={gpu.name}>
            {gpu.name}
          </span>
        )}
      </div>

      {gpu && totG > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ height: 6, background: C.code, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, ratio * 100)}%`, height: '100%', background: barColor, transition: 'width .3s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: C.muted }}>
            <span>VRAM</span>
            <span style={{ color: C.sub }}>{usedG.toFixed(1)} / {totG.toFixed(1)} GB</span>
          </div>
        </div>
      ) : usedG > 0 ? (
        <div style={{ fontSize: 9, color: C.muted }}>{usedG.toFixed(1)} GB resident in VRAM</div>
      ) : null}
    </div>
  );
}
