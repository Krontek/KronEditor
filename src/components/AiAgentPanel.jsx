import { useState, useRef, useEffect, useCallback } from 'react';
import { host } from '../services/HostClient';
import { TOOL_DEFS, applyToolCall, buildProjectOverview, findPOU, summarizeLiveSamples, summarizeWatch } from '../services/agentTools';
import { setEditorScope, EDITOR_SCOPE } from '../utils/editorScope';
import PasswordInput from './common/PasswordInput';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Image-attachment support. Only the providers below accept multimodal
// content blocks on the wire (see host-agent/ai.go: callAnthropic and
// callOpenAI — the latter also covers "custom" and "gemini"/"google", which
// route through the same OpenAI-compatible /chat/completions shape). Ollama
// is excluded for now — its /api/chat image field is a different scheme.
// 'deepseek' and 'ollama' are absent on purpose: DeepSeek's chat models are
// text-only, and a local model's vision support depends on the pulled tag —
// attaching an image to either would fail at the provider, not here.
const IMAGE_CAPABLE_PROVIDERS = new Set(['anthropic', 'anthropic-oauth', 'openai', 'custom', 'gemini', 'google']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8MB per image — generous but catches accidental huge pastes early
const MAX_IMAGES = 5;                       // mirrors typical chat-UI limits (VS Code Copilot Chat, Claude.ai)

let _attachId = 0;
const nextAttachId = () => ++_attachId;

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      resolve({
        id: nextAttachId(),
        name: file.name || 'image',
        mimeType: file.type || 'image/png',
        size: file.size,
        data: comma >= 0 ? dataUrl.slice(comma + 1) : '',
        previewUrl: dataUrl,
      });
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

// Abortable wait, used for the watch_live_variables real-time pause so Stop
// can cut it short instead of having to wait out the full window.
const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  const id = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(id);
    reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

/*
 * AiAgentPanel — the PLC Agent: a project-editing tool-calling agent.
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

// ⚠️ These `models` lists are only the OFFLINE FALLBACK. The settings tab asks
// the provider for its real catalogue on open (host.aiModels → /api/host/ai/models)
// and shows that instead; a hardcoded list goes stale every time a model ships,
// which is exactly how this list came to offer Opus 4.8 as its newest Claude.
// Keep them short and current — they are what the user sees when the provider is
// unreachable or no key/sign-in is configured yet.
// `auth` groups the picker: 'login' = sign in with an existing subscription (no
// key to paste), 'key' = paste an API key, 'local' = runs on this machine,
// 'custom' = your own OpenAI-compatible endpoint. ⚠️ Only providers with a
// working OAuth backend belong in 'login' — see AUTH_GROUPS below.
const PROVIDERS = [
  { id: 'anthropic-oauth', label: 'Claude account', auth: 'login', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { id: 'anthropic', label: 'Anthropic', auth: 'key', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { id: 'openai', label: 'OpenAI', auth: 'key', models: ['gpt-4.1', 'gpt-4o', 'o4-mini'] },
  // ⚠️ Uses the `-latest` ALIASES first: they always resolve to the current
  // model, so this list cannot go stale the way the old `gemini-2.5-*` entries
  // did (those now 404 with "no longer available to new users" for any new key).
  // Ordered by capability, NOT by what some particular key has quota for —
  // whether a given model is reachable depends on the account's plan, and the
  // 429/404 handling in ai.go explains that when it isn't.
  { id: 'gemini', label: 'Google (Gemini)', auth: 'key', models: ['gemini-pro-latest', 'gemini-flash-latest', 'gemini-3.1-pro-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'] },
  // deepseek-chat leads: it's the tool-calling model, and the agent is useless
  // without tool calls. deepseek-reasoner is listed but is a reasoning model —
  // check DeepSeek's docs for its current function-calling support before use.
  { id: 'deepseek', label: 'DeepSeek', auth: 'key', models: ['deepseek-chat', 'deepseek-reasoner'] },
  // Ollama's live list is what's INSTALLED, so its fallback must be pullable
  // tags from OLLAMA_CATALOG below — bare names like "qwen2.5-coder" aren't.
  { id: 'ollama', label: 'Ollama', auth: 'local', models: ['qwen2.5-coder:7b', 'qwen2.5-coder:14b', 'deepseek-coder-v2:16b', 'llama3.1:8b'] },
  { id: 'custom', label: 'Custom endpoint', auth: 'custom', models: [] },
];

// ⚠️ 'login' currently holds ONLY anthropic-oauth, and that is a capability
// limit rather than an oversight. OpenAI and Google both expose PKCE OAuth
// (verified: auth.openai.com and accounts.google.com serve OIDC discovery with
// S256), but a subscription token from those flows is scoped to their OWN
// coding agent's backend — it does NOT authenticate /v1/chat/completions or
// generativelanguage.googleapis.com, so `callOpenAI` cannot use it. Adding
// either means writing a new backend dialect (as callAnthropic needed for its
// OAuth mode), not just an entry here. DeepSeek serves no OIDC discovery at all
// — API key only. Do not move a provider into 'login' before its token is
// verified end-to-end against a chat endpoint this app actually calls.
// Per-provider sign-in wiring: which HostClient methods drive the flow, plus
// the copy shown in the settings block. Adding a `login` provider means adding
// a row here — the UI is fully driven off it.
const LOGIN_PROVIDERS = {
  'anthropic-oauth': {
    start: 'anthropicOAuthStart', status: 'anthropicOAuthStatus', logout: 'anthropicOAuthLogout',
    button: '🔐 Sign in with Claude', signedIn: '✓ Signed in to your Claude account',
    blurb: 'Sign in with your Claude Pro/Max subscription — no API key. Opens claude.ai in your browser; once you authorize, it connects automatically (no code to paste).',
    note: "Uses Claude Code's OAuth; gray-area for 3rd-party use — your call.",
  },
};

const AUTH_GROUPS = [
  ['login', 'Sign in with your subscription'],
  ['key', 'API key'],
  ['local', 'Local (runs on this machine)'],
  ['custom', 'Self-hosted / other'],
];

// Default model per provider — the first fallback entry (Claude providers lead
// with the current Opus, so a fresh install lands on it rather than on whatever
// happened to be newest when this file was last edited).
const defaultModelFor = (providerId) => PROVIDERS.find((p) => p.id === providerId)?.models[0] || '';

// Curated catalog of local (Ollama) models the user can pull with one click.
// `id` must match the exact Ollama tag so installed-state detection works.
const OLLAMA_CATALOG = [
  { id: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', size: '~1.0 GB', desc: 'Fast, lightweight coding assistant' },
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', size: '~4.7 GB', desc: 'Strong, balanced coding model', recommended: true },
  { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', size: '~9.0 GB', desc: 'Higher quality, needs more RAM' },
  { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', size: '~8.9 GB', desc: 'Strong code generation' },
  { id: 'codellama:7b', label: 'Code Llama 7B', size: '~3.8 GB', desc: "Meta's code model — no native tool API (uses a prompt fallback; less reliable for the agent)" },
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
    else if (ch === '}') { if (depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push({ raw: text.slice(start, i + 1), start }); start = -1; } } }
  }
  return out;
}

// The last KNOWN tool name mentioned in `text` (and where). Used to pair a bare
// args object with the tool whose name the model wrote in surrounding prose
// (e.g. a markdown heading "**create_pou**" right before the JSON args).
// ⚠️ Route a BARE args object by its SHAPE before falling back to the prose.
// `lastToolMention` scans the text preceding the object, but that text includes
// EARLIER JSON BLOCKS — so a second, unnamed block inherits the first block's
// tool name. Observed with llama3.1:8b: it emitted `{"name":"create_pou",…}`
// and then a bare `{"pou":"Counter","rungs":[…]}`, which was routed to
// create_pou and died with "name is required" instead of running as set_ladder.
// A distinctive argument key is far stronger evidence than a name that merely
// appeared somewhere earlier. Only unambiguous keys belong here: add/update/
// remove_variable all share {name,pou,scope}, so they stay with the prose scan.
const ARG_SHAPE_TOOL = [
  ['rungs', 'set_ladder'],
  ['code', 'set_st_code'],
  ['newName', 'rename_pou'],
  ['kind', 'create_data_type'],
];
function toolFromArgShape(o) {
  for (const [key, tool] of ARG_SHAPE_TOOL) {
    if (o && o[key] !== undefined && KNOWN_TOOLS.has(tool)) return tool;
  }
  return null;
}

function lastToolMention(text) {
  let best = null, bestIdx = -1;
  for (const name of KNOWN_TOOLS) {
    const idx = text.lastIndexOf(name);
    if (idx > bestIdx) { bestIdx = idx; best = name; }
  }
  return best;
}

// The explicit arguments object inside a tool-call wrapper, or null if the
// object has no wrapper key (i.e. it IS the flat args).
function explicitArgs(o) {
  if (o.arguments !== undefined) return o.arguments;
  if (o.parameters !== undefined) return o.parameters;
  if (o.args !== undefined) return o.args;
  return null;
}

// Some models (especially local ones) emit tool calls as plain TEXT instead of
// the provider's structured tool_calls field — and weaker ones split them into
// MARKDOWN where the tool NAME is a heading and only the ARGUMENTS are JSON:
//   1. **create_pou**
//      { "name": "Blinker", "language": "ST" }
// Recover BOTH shapes: a proper { name, arguments } object, OR a bare args
// object paired with the nearest preceding tool-name mention. Returns a
// normalized toolCalls array, or null if none found.
function extractInlineToolCalls(content) {
  if (!content) return null;
  // Strip code-fence markers (keep their contents) so fenced blocks are scanned.
  const text = content.replace(/```(?:json)?/gi, '').replace(/```/g, '');
  const calls = [];
  const pushCall = (name, args) => {
    if (!KNOWN_TOOLS.has(name)) return;
    calls.push({ id: `inline_${calls.length}`, name, _synth: true, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
  };
  // Turn one parsed object into a call: prefer its own tool name + explicit args;
  // else treat it as flat args for `fallbackName` (the surrounding-text tool name).
  const consume = (o, fallbackName) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.name === 'string' && KNOWN_TOOLS.has(o.name)) {
      const a = explicitArgs(o);
      if (a !== null) { pushCall(o.name, a); return; }
      const flat = { ...o }; delete flat.name;   // flat args that included the tool name
      pushCall(o.name, flat);
      return;
    }
    // Bare args: shape first (a distinctive key), prose only as a last resort.
    const byShape = toolFromArgShape(o);
    if (byShape) { pushCall(byShape, o); return; }
    if (fallbackName) pushCall(fallbackName, o);
  };

  // A whole-array / single-object form first: [ {…}, {…} ] or { name, arguments }.
  try {
    const arr = JSON.parse(text.trim());
    const items = Array.isArray(arr) ? arr : [arr];
    items.forEach((o) => consume(o, null));
    if (calls.length) return calls;
  } catch { /* not clean JSON — scan embedded objects */ }

  for (const { raw, start } of findJsonObjects(text)) {
    let o;
    try { o = JSON.parse(raw); }
    catch {
      // Repair the array-vs-object bracket malformation and retry
      // (e.g. set_ladder's `rungs: [["outputs":…]]` → `[{"outputs":…}]`).
      try { o = JSON.parse(repairJsonBrackets(raw)); } catch { continue; }
    }
    consume(o, lastToolMention(text.slice(0, start)));
  }
  return calls.length ? calls : null;
}

// Weak models, after several turns, sometimes stop calling tools entirely and
// just PRINT the POU body inside a ```st / ```iec-st / ``` code block (treating
// the chat as a code-display, not an action). Recover the first such block as a
// set_st_code call (no `pou` — the dry-run POU inference targets the open POU).
// Skips JSON blocks (handled by extractInlineToolCalls) and only accepts content
// that actually looks like ST, so a prose block isn't mistaken for code.
function recoverStCodeBlock(text) {
  if (!text) return null;
  const fence = /```([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) {
    const tag = (m[1] || '').toLowerCase();
    const body = m[2];
    const t = (body || '').trim();
    if (!t || t.startsWith('{') || t.startsWith('[')) continue;       // JSON → handled elsewhere
    const tagged = /^(st|scl|iec|iec-?st|iecst|pascal|structured-?text)$/i.test(tag);
    const looksST = /:=|\bIF\b|\bEND_IF\b|\bVAR\b|\bFOR\b|\bWHILE\b|\bCASE\b|\bEND_/i.test(body);
    if (tagged || looksST) {
      return [{ id: 'inline_code', name: 'set_st_code', _synth: true, arguments: JSON.stringify({ code: body.replace(/\s+$/, '') }) }];
    }
  }
  return null;
}

// Some models emit tool calls in a NON-JSON `tool_name key="value" key=value`
// form (one call per block; quoted values may span newlines — e.g. set_st_code's
// `code="…multi-line…"`). Parse those: locate each known tool name at a call
// position (line start, optional bullet/**), then read its key/value args up to
// the next tool name. Returns a normalized toolCalls array, or null.
function parseKeyValArgs(s) {
  const args = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const km = /^([A-Za-z_]\w*)[ \t]*=/.exec(s.slice(i));
    if (!km) break;
    const key = km[1];
    i += km[0].length;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    let val = '';
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]; i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) { val += s[i + 1]; i += 2; }
        else { val += s[i]; i++; }
      }
      i++; // closing quote
    } else {
      while (i < s.length && !/\s/.test(s[i])) { val += s[i]; i++; }
    }
    args[key] = val;
  }
  return args;
}

function extractKeyValToolCalls(content) {
  if (!content) return null;
  const text = content.replace(/```(?:json|st|iec-?st|pascal)?/gi, '').replace(/```/g, '');
  const names = [...KNOWN_TOOLS].join('|');
  // tool name at a line start (optional "1. " / "- " / "**"), followed by ` key=`.
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:[-*]\\s*|\\d+[.)]\\s*)?(?:\\*\\*)?(${names})(?:\\*\\*)?[ \\t]+(?=[A-Za-z_]\\w*[ \\t]*=)`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) hits.push({ name: m[1], start: m.index + m[0].length });
  const calls = [];
  for (let k = 0; k < hits.length; k++) {
    const end = k + 1 < hits.length ? hits[k + 1].start : text.length;
    const args = parseKeyValArgs(text.slice(hits[k].start, end));
    if (Object.keys(args).length) calls.push({ id: `kv_${k}`, name: hits[k].name, _synth: true, arguments: JSON.stringify(args) });
  }
  return calls.length ? calls : null;
}

// Whether to mine the model's REPLY TEXT for tool calls it failed to emit
// structurally. True only for the providers those recovery layers were built
// for — a local daemon (Ollama) or an unknown OpenAI-compatible gateway, which
// may front a model with no reliable native tool API. Every first-party
// provider here (Anthropic, OpenAI, Gemini, DeepSeek) emits real tool calls, so
// for them a text-only turn means the model is FINISHED and must end the loop.
function recoverToolCallsFromText(provider) {
  return provider === 'ollama' || provider === 'custom';
}

// ⚠️ A tool call we SYNTHESIZED from the model's prose (the `_synth` flag set by
// extractInlineToolCalls / extractKeyValToolCalls / recoverStCodeBlock) must
// NEVER be replayed to the provider as a real tool call. The model never made
// it, so it carries no provider-issued call id and no opaque per-call blob —
// and Gemini 3 hard-rejects the WHOLE next request with
//   400 "Function call is missing a thought_signature in functionCall parts …
//        function call `default_api:set_st_code`, position 7"
// which kills the run with no way to recover (a thought_signature cannot be
// fabricated). Observed end-to-end: Gemini finished its work, replied with a
// prose summary containing an ```iecst block, recoverStCodeBlock turned that
// summary into a set_st_code, and every following turn 400'd.
//
// So the recovered call still EXECUTES locally (that is the point of the
// recovery), but in the transcript it is demoted to plain text: the assistant
// message keeps only calls the provider actually emitted, and each synthesized
// call's `tool` result becomes a user-role line. That also keeps the
// every-tool_call_id-needs-a-result invariant intact — a dangling tool result is
// itself a 400 on Anthropic and OpenAI.
function providerSafeMessages(msgs) {
  const synthIds = new Set();
  for (const m of msgs) {
    for (const c of m.toolCalls || []) if (c._synth && c.id) synthIds.add(c.id);
  }
  if (synthIds.size === 0) return msgs;
  return msgs.map((m) => {
    if (m.role === 'tool' && synthIds.has(m.toolCallId)) {
      return { role: 'user', content: `[recovered tool result] ${m.name}: ${m.content}` };
    }
    if (m.role !== 'assistant' || !(m.toolCalls || []).length) return m;
    const real = m.toolCalls.filter((c) => !c._synth);
    if (real.length === m.toolCalls.length) return m;
    const noted = m.toolCalls
      .filter((c) => c._synth)
      .map((c) => `[recovered from your reply text and executed] ${c.name}(${typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})})`)
      .join('\n');
    const content = [m.content, noted].filter((s) => s && String(s).trim()).join('\n');
    const out = { ...m, content };
    if (real.length) out.toolCalls = real; else delete out.toolCalls;
    return out;
  });
}

// Tools that act on a single LOCAL POU and therefore need a valid `pou` arg.
// (Variable tools only need it for local scope; set_st_code/set_ladder always.)
function needsLocalPou(name, args) {
  if (name === 'set_st_code' || name === 'set_ladder') return true;
  if (name === 'add_variable' || name === 'update_variable' || name === 'remove_variable') return args.scope !== 'global';
  return false;
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

// Which POU to bring to the screen after a proposal is applied — so the user
// SEES what the agent wrote. Prefer the POU whose code/ladder was set (that's
// the visible result), then a newly created one, then any touched POU.
function focusTarget(steps) {
  let codeWrite = null, created = null, any = null;
  for (const s of steps) {
    if (!(s.res?.mutation && s.res.ok)) continue;
    const a = s.args || {};
    if (s.tc.name === 'set_st_code' || s.tc.name === 'set_ladder') codeWrite = a.pou || codeWrite;
    else if (s.tc.name === 'create_pou') created = a.name || created;
    if (a.pou) any = a.pou;
    else if (a.newName) any = a.newName;
    else if (a.name && s.tc.name.endsWith('_pou')) any = a.name;
  }
  return codeWrite || created || any || null;
}

// System prompt: the agent's role + project conventions + a COMPACT project map
// (POU names + globals only — small, so it fits a modest context window and the
// model always sees every POU). Details come on demand via read_pou /
// get_project_overview, not by embedding the full overview each turn.
// Volatile project state — sent as the separate `context` field so the host
// agent can place it AFTER the Anthropic prompt-cache breakpoints (a trailing
// <project-context> block). Keeping it OUT of the system prompt is what lets
// the big prefix (tools + rules + block catalog + history) stay byte-identical
// across agent-loop turns: with it inlined, every project edit invalidated the
// whole cache and each turn re-billed everything at full input price.
function buildProjectContext(projectStructure, board, activeItem) {
  const overview = buildProjectOverview(projectStructure, board);
  const active = activeItem ? `${activeItem.name} (${activeItem.type})` : 'none';
  const pous = overview.pous.map((p) => `${p.name}[${p.language}${p.returnType ? ' ' + p.returnType : ''}]`).join(', ') || '(none)';
  const globals = overview.globalVariables.map((g) => g.name).join(', ') || '(none)';
  const dts = overview.dataTypes.map((d) => d.name).join(', ');
  const projBlocks = [
    ...(projectStructure?.functionBlocks || []).map((p) => p.name),
    ...(projectStructure?.functions || []).map((p) => p.name),
  ].join(', ');
  return [
    `Board: ${board || 'none'}. Currently open POU: ${active}.`,
    `POUs (${overview.pous.length}): ${pous}.`,
    `Global variables: ${globals}.`,
    dts ? `Data types: ${dts}.` : '',
    projBlocks ? `Project-defined blocks (call list_blocks for their pins): ${projBlocks}` : '',
  ].filter(Boolean).join('\n');
}

// STABLE system prompt — must stay byte-identical across turns (it is the
// prompt-cache prefix). Only libraryData (static per session) and agentMode
// (rarely toggled) feed it; live project state goes via buildProjectContext.
function buildSystemPrompt(libraryData = [], agentMode = 'manual') {
  // Compact catalog: standard block type names grouped by category + project FB/
  // function names. NAMES only (scales as the XML grows); pins come from list_blocks.
  const libLine = (Array.isArray(libraryData) ? libraryData : [])
    .map((c) => { const names = (c.blocks || []).map((b) => b.blockType).filter(Boolean); return names.length ? `${c.title}: ${names.join(', ')}` : ''; })
    .filter(Boolean).join(' | ');
  return [
    'You are the embedded engineering agent for KronEditor, an IEC 61131-3 PLC editor.',
    'You edit the project by calling tools: create/rename/delete POUs, rewrite Structured Text, set ladder, and add/update/remove variables (local + global).',
    '',
    'Rules:',
    '- The selected board is READ-ONLY context. Never change hardware.',
    '- All generated code, names and comments in English. Names must be IEC identifiers (letters/digits/underscore, no spaces, no leading digit).',
    '',
    'CLARIFY FIRST when the request is ambiguous — ALWAYS via the ask_user TOOL:',
    '- ⚠️ NEVER write a question as prose. A question typed into your reply text is a FAILED response: it does not pause the loop and the user cannot click it. Every question goes through ask_user, one question per call.',
    '- ⚠️ GIVE `options` WHENEVER THE ANSWER IS A CHOICE. They become clickable buttons — one click instead of typing. Almost every clarification you need here IS a choice: language (Ladder / Structured Text), FB vs plain variable (MC_Power motion FB / BOOL flag), ramp vs instant step, which I/O channel (UART0 / UART1 / USB0), which data type (INT / DINT / REAL), trigger style (level / rising edge). Omit `options` ONLY for a genuinely open answer — a number, a name, an IEC address — which then renders as a text box.',
    '- Emit ALL the questions you need as separate ask_user calls in the SAME turn. They are shown to the user one at a time and the answers come back together, so you still get a single round without cramming several questions into one message. Emit no other tool in that turn.',
    '- Ask when, for example: a named "block" could be a FUNCTION BLOCK or a plain variable (e.g. "mc_power" → the MC_Power motion FB, or a BOOL?); the language (ST / LD / SCL) is unspecified for non-trivial logic; a variable\'s type / range / IEC address, or an FB\'s axis / pin wiring, is needed but unknown; which I/O channel (UART/USB/GPIO…) to use is unclear; or any choice would otherwise be a GUESS that changes the result.',
    '- Do NOT interrogate over trivia you can reasonably default, and NEVER ask the user to write the code/ladder for you — you author it; you only clarify REQUIREMENTS.',
    '',
    'LANGUAGE CHOICE (per RUNG, not per POU):',
    '- Every POU is a list of RUNGS; each rung is Ladder OR Structured Text. create_pou makes the unified rung-based POU — then author ladder rungs with set_ladder and/or ST with set_st_code (both work on every POU).',
    '- ⚠️ WHEN THE USER ASKS FOR LADDER ("ladder", "LD", "merdiven", "ladder diagram", "rung", "kontak/coil") THAT IS A HARD REQUIREMENT, NOT A HINT. You MUST call set_ladder. It OVERRIDES every content-based preference below. Writing the whole thing in ST after the user said "ladder" is a FAILED response, even if the ST is correct.',
    '- Ladder handles: contacts (NO/NC/Rising/Falling), coils (Normal/Set/Reset/Negated), AND one stateful function block per rung via `fb` (TON/TOF/TP/TONR, CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS, communication FBs, user FBs).',
    '- ⚠️ COUNTING AND TIMING ARE LADDER-NATIVE — they are NOT "math". A count-up/count-down to a limit is CTU/CTD/CTUD, whose PV pin IS the limit and whose Q/QU/QD output already tells you the limit was reached: you do NOT need a comparison block for "count to 10". A periodic pulse is a self-resetting TON (`branches:[[{"contact":"tick.Q","subType":"NC"}]], fb:{type:"TON",instance:"tick",inputs:{"PT":"T#1s"}}`). Latching a direction is SR/RS. Reaching for ST because you saw "+ 1" or ">= 10" is the single most common mistake here.',
    '- Use ST (set_st_code) ONLY for what ladder genuinely cannot express: arithmetic on values (ADD/MOVE/scaling), comparisons that are not an FB pin, loops/CASE/IF chains, motion (MC_*), string/array handling.',
    '- If the user asked for ladder but ONE part truly needs ST, still build the ladder rungs with set_ladder and put only that part in an ST rung — then say in your reply which part had to be ST and why. Mixing both in one POU is normal (it is one rung list).',
    '- If the user does NOT specify a language: boolean interlocks + timers/counters → ladder; computation-heavy logic → ST.',
    '- A minimal LD rung exists — even a single coil with no contacts is valid: `rungs: [{ "outputs": [{"coil": "mc_power"}] }]`. Do NOT fall back to ST just because the requested logic is trivial.',
    '- set_ladder AUTO-DECLARES referenced variables that do not exist (contacts/coils → BOOL, fb.instance → the FB type) and lists them in the diff — do not emit add_variable calls for plain ladder contacts/coils/instances unless you need a non-default type, initial value or address.',
    '',
    'GENERAL:',
    '- Do NOT invent variables the user did not ask for. Only add the variables the user explicitly named, plus FB instances genuinely required by ST you write (e.g. a TON for a timer). NEVER add helper variables like `motor_enabled`, `temp`, `flag` unless the user asked for them or the ST you write actually references them.',
    '- "BLOCK"/"blok"/"FB" terminology: when the user calls something a "block" (e.g. "mc_power blogu", "a TON block") and its name matches a standard/library block IGNORING case and underscores (mc_power→MC_Power, ton→TON, ctu→CTU), it is a FUNCTION BLOCK INSTANCE of THAT type — NOT a plain variable. You MUST: call list_blocks for its real pins, then add_variable with type = the FB type name (e.g. type "MC_Power"), then CALL it in ST. NEVER create a BOOL merely named after a known block (a `mc_power : BOOL` coil is WRONG when the user asked for the MC_Power block). Any separate "power"/"enable"/"güç" bool the user mentions is a DISTINCT BOOL variable that feeds the FB\'s Enable input — add it too.',
    '- Stateful FBs (timers TON/TOF/TP/TONR, counters CTU/CTD, edges R_TRIG/F_TRIG, bistables SR/RS, communication, user FBs) CAN live in a ladder rung: set_ladder\'s `fb` field — power flows contact network → trigger pin → Q → coils; other pins via fb.inputs (literals or variable names) and fb.outputs (capture ET/CV into variables). Inline math/compare/move (ADD, GT, MOVE, …) and motion (MC_*) CANNOT — write those in an ST rung. Do NOT silently downgrade an FB to a BOOL to fit ladder.',
    '- Structured Text must be valid IEC 61131-3: := assign; AND/OR/NOT logical; BAND/BOR/BXOR/BNOT bitwise; time literals like T#500ms.',
    '- Reference every variable by its BARE name — NEVER prefix it with `global.`, `GVL.`, a program name, or any namespace. Write `led := NOT led;` and `blink(IN := NOT blink.Q, PT := T#1s);` — NOT `global.led` or `global.blink.Q`. (This is not CODESYS; there is no global namespace object.) Member access (`blink.Q`, `blink.ET`) is only for reading an FB instance\'s output pins.',
    '- Before using a variable in ST, add it with add_variable (in the SAME response). Conversely: every variable you add_variable for MUST be referenced in the body you write — no dead vars.',
    '- Variables default to LOCAL scope. For a LOCAL variable you MUST pass BOTH scope "local" AND pou = the exact POU name it belongs to (usually the POU you just created in this same response). Never omit `pou` for a local variable. Use scope "global" ONLY when the user explicitly says global/shared, or the variable must be used by more than one POU.',
    '- ORDER within one response: create_pou FIRST, then add_variable (with that pou) for every variable, then set_ladder / set_st_code last. Use the SAME POU name string everywhere.',
    '- Make the smallest change that satisfies the request; prefer editing an existing POU over creating new ones unless asked. delete_pou/remove_variable only when explicitly asked.',
    '- Once requirements are clear (after any CLARIFY questions are answered), finish the WHOLE request in your tool calls before replying — if asked to create a POU AND write its code, emit create_pou THEN set_st_code/set_ladder AND the add_variable calls. NEVER ask the user to "provide the code" or hand the coding back to them; you write it. (Asking to clarify REQUIREMENTS is fine; asking them to do the coding is not.)',
    '- set_st_code replaces the WHOLE body and takes ONLY plain executable statements — NO wrappers and NO OOP. Do NOT emit PROGRAM/END_PROGRAM, FUNCTION/FUNCTION_BLOCK, VAR/END_VAR, and especially NOT `METHOD … END_METHOD` / PROPERTY / ACTION (this is not CODESYS — there are no methods). NO `RETURN <value>;` (a program returns nothing). Just write the statements that run each scan; variables go via add_variable. set_ladder replaces all rungs.',
    '- PLC logic runs ONCE per scan, cyclically — NEVER write unbounded loops (no WHILE TRUE; it hangs the PLC). For timing use a TON across scans, e.g. `pulse(IN := NOT pulse.Q, PT := T#1s); IF pulse.Q THEN out := NOT out; END_IF`.',
    '- Function blocks (TON, TOF, TP, CTU, CTD, R_TRIG, motion MC_*, communication, user FBs) are INSTANCES, not functions. For each you must: (1) add_variable with type = the FB name itself (e.g. type "TON" — NOT "TIME"/"BOOL"); (2) CALL it as `name(IN := …, PT := …);`; (3) read its outputs as `name.Q`, `name.ET`. NEVER write `name := TON(…)` — assigning an FB call is invalid IEC and will not compile.',
    '- ARRAYS, STRUCTS, and ENUMS are NEVER written inline into a variable\'s type. NEVER set a variable\'s type to a literal like "ARRAY[0..31] OF BYTE" or "STRUCT...END_STRUCT" — the transpiler does not parse that and it silently produces broken generated code. Instead: (1) call create_data_type ONCE to define the named type (kind ARRAY/STRUCT/ENUM — e.g. create_data_type {"name":"RxFrame","kind":"ARRAY","baseType":"BYTE","dimensions":[{"min":0,"max":31}]}), then (2) add_variable/update_variable with type set to that NAME (e.g. type:"RxFrame"). Reuse an existing data type by name (see "Data types" below) instead of creating a duplicate with the same shape.',
    '- The blocks below are only NAMES — you do NOT know their exact pins from memory. BEFORE using any function block or function (standard or project-defined) in ST, call list_blocks (optionally filtered, e.g. {"filter":"MC_"}) to get its real input/output pin names and types, then use those exact pin names.',
    '- set_ladder example with a timer: {"pou":"Main","rungs":[{"branches":[[{"contact":"Sensor"}]],"fb":{"type":"TON","instance":"delayT","inputs":{"PT":"T#5s"}},"outputs":[{"coil":"Lamp"}]}]} — Lamp energizes 5s after Sensor. The trigger pin (IN/CU/CLK…) is fed by the rung power flow automatically; never put it in fb.inputs.',
    '- A correct TON blink is EXACTLY: declare `blink : TON;` (add_variable type TON) and `led : BOOL`, then body `blink(IN := NOT blink.Q, PT := T#500ms); IF blink.Q THEN led := NOT led; END_IF;`. Do not also toggle led outside the IF.',
    '- CRITICAL: you change the project ONLY by emitting tool calls. NEVER write code in prose and claim it is done; NEVER output "APPLIED:" or "I have set the code" — the SYSTEM applies + confirms. To write code into a POU you MUST call set_st_code/set_ladder.',
    agentMode === 'auto'
      ? '- AUTO mode is active: your changes are applied to the project immediately (no approval step). Still make each change deliberately and verify it; the user sees every change as an applied diff. When done, reply with a short summary in the user\'s language.'
      : '- Every change is shown as a diff the user approves/rejects; if rejected, adapt. When done, reply with a short summary in the user\'s language.',
    '- To SEE the existing program before editing it, call read_pou: it returns the full ST code AND, for LD/SCL, each rung rendered as boolean logic (e.g. `Motor := (Start OR Motor) AND NOT Stop`) plus the variable table. Use get_project_overview for the project-wide picture.',
    '- While the program is RUNNING, read_live_variables returns the current values AND a buffered time-series `history` per variable (min/max/last, change count, flags like constant/oscillating/rising/falling, a recent sample series). Read it to diagnose real behaviour (a value stuck, oscillating, drifting, out of range) BEFORE proposing a fix, and refer to the concrete numbers when you explain the problem.',
    '- For TIME-DEPENDENT behaviour use watch_live_variables: it actively WAITS a real window and returns a per-variable summary, and EACH variable can be watched for its own duration (e.g. watch a 5 s timer output for 12 s but a fast pulse for 2 s). read_live_variables is just an instant snapshot; watch_live_variables is for "does it toggle / settle / ramp over time". There is NO fixed cap — pick whatever window the behaviour under diagnosis actually needs (a few seconds for a fast pulse, minutes for a slow ramp/drift/long sequence), but default to the SHORTEST window that answers the question; do not pick a long duration "just in case". The user sees a live elapsed-time counter while you watch and can stop it early, so an overly long pick wastes their time waiting on you, not just yours.',
    '- VERIFY-AFTER-CHANGE LOOP: live monitoring is automatic whenever the program is running (simulation or a connected PLC) — your edits are committed to the project on approval, but to take effect on the RUNNING target they must be DEPLOYED by the user (Build & Send). When the program is running, after your change is in effect call watch_live_variables on the variables your fix targets, compare the observed behaviour against what the user asked for, and report explicitly whether the desired result was achieved (if not, propose another fix). If the live values do NOT yet reflect your change, it has not been deployed — tell the user to Build & Send. Keep watch durations only as long as needed.',
    '- YOU CANNOT COMPILE, AND MUST NOT TRY. There is no compile/build tool. Never attempt to build, transpile or "verify by compiling", and never claim you compiled something. Get the code right by READING the ST/LD source and the variable declarations; if the user asks about compile errors, tell them to press Build in the toolbar and paste the output, then diagnose it from the text.',
    '',
    libLine ? `Standard library blocks (names only — call list_blocks for pins): ${libLine}` : '',
    'The CURRENT project state (selected board, open POU, POU list, global variables, data types, project-defined blocks) arrives in a <project-context> block at the END of the conversation, refreshed every turn — always trust the latest one.',
  ].filter(Boolean).join('\n');
}

export default function AiAgentPanel({
  activeItem = null,
  projectStructure = null,
  setProjectStructure = null,
  selectedBoard = null,
  libraryData = [],            // standard block library (XML) — block types + I/O pins, for list_blocks
  liveVariables = null,        // live values from the running sim/PLC (for read_live_variables)
  onApplied = null,            // (pouNames[]) → reload the open editor after a commit
  onHotSwap = null,            // (pouNames[]) → push an online change while running
  hotSwapActive = false,       // a live hot-swap session is running
  onStartHotSwap = null,       // () → build+run a hot-swap session (online change)
  onStopHotSwap = null,        // () → stop the hot-swap session
  askRequest = null,           // {text, id} pushed from the output-panel "Ask agent" — auto-sends once
}) {
  const [config, setConfig] = useState(loadConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [draftCfg, setDraftCfg] = useState(() => config || { provider: 'anthropic', model: defaultModelFor('anthropic'), apiKey: '', baseUrl: '' });
  // ⚠️ apiKey and baseUrl belong to ONE provider and must not ride along to the
  // next one. Switching provider used to keep both: an Ollama baseUrl left in
  // the draft made a freshly-pasted Gemini key POST to http://localhost:11434
  // ("connection refused" while the key was perfectly fine), and a key entered
  // for one vendor would be sent as a Bearer token to another. The fields are
  // stashed per provider so flipping back and forth is still non-destructive.
  const credStashRef = useRef({});
  const switchProvider = (id) => setDraftCfg((d) => {
    credStashRef.current = { ...credStashRef.current, [d.provider]: { apiKey: d.apiKey, baseUrl: d.baseUrl } };
    const prev = credStashRef.current[id] || {};
    return { provider: id, model: defaultModelFor(id), apiKey: prev.apiKey || '', baseUrl: prev.baseUrl || '' };
  });
  // Account OAuth: connection status + the "waiting in browser" flow.
  // ⚠️ Keyed BY PROVIDER. There is more than one sign-in provider now, and a
  // single shared flag would report "signed in" for Google merely because the
  // user had signed in to Claude (and vice-versa) — the settings block and the
  // header's ready-pill both read it.
  const [oauthByProvider, setOauthByProvider] = useState({}); // id → {connected, checked}
  const [oauth, setOauth] = useState({ busy: false, error: '' }); // transient, current flow only
  const [oauthPending, setOauthPending] = useState(false); // authorize URL opened, polling for completion
  const oauthPollRef = useRef(null);

  const refreshOauth = useCallback(async (providerId) => {
    const def = LOGIN_PROVIDERS[providerId];
    if (!def) return;
    const mark = (connected) => setOauthByProvider((m) => ({ ...m, [providerId]: { connected, checked: true } }));
    try { const r = await host[def.status](); mark(!!r.connected); }
    catch { mark(false); }
  }, []);
  // Check every sign-in provider once at mount: the saved provider needs it for
  // the ready-pill, and the settings block needs it the moment it's opened.
  useEffect(() => { Object.keys(LOGIN_PROVIDERS).forEach(refreshOauth); }, [refreshOauth]);
  useEffect(() => () => { if (oauthPollRef.current) clearInterval(oauthPollRef.current); }, []);

  // Loopback flow (matches VSCode): open the authorize URL, then poll status —
  // the host-agent catches the browser redirect at :7171/callback and stores
  // the tokens, so there is NO code to paste.
  const startSignIn = async (providerId) => {
    const def = LOGIN_PROVIDERS[providerId];
    if (!def) return;
    setOauth({ busy: true, error: '' });
    try {
      const r = await host[def.start]();
      window.open(r.authorizeUrl, '_blank', 'noopener');
      setOauthPending(true);
      setOauth({ busy: false, error: '' });
      if (oauthPollRef.current) clearInterval(oauthPollRef.current);
      const t0 = Date.now();
      oauthPollRef.current = setInterval(async () => {
        try {
          const s = await host[def.status]();
          if (s.connected) {
            clearInterval(oauthPollRef.current); oauthPollRef.current = null;
            setOauthByProvider((m) => ({ ...m, [providerId]: { connected: true, checked: true } }));
            setOauth({ busy: false, error: '' });
            setOauthPending(false);
            const next = { provider: providerId, model: draftCfg.model || defaultModelFor(providerId), apiKey: '', baseUrl: '' };
            setDraftCfg(next); saveConfig(next); setConfig(next);
            // The catalogue fetch before sign-in had no token to send, so it fell
            // back to the built-in list — re-read it now that we're authorized.
            refreshModelsRef.current?.();
          } else if (Date.now() - t0 > 180000) {
            clearInterval(oauthPollRef.current); oauthPollRef.current = null;
            setOauthPending(false);
            setOauth({ busy: false, error: 'Timed out waiting for authorization.' });
          }
        } catch { /* keep polling */ }
      }, 1500);
    } catch (e) {
      setOauth({ busy: false, error: e.message || 'sign-in failed' });
    }
  };
  const cancelSignIn = () => {
    if (oauthPollRef.current) { clearInterval(oauthPollRef.current); oauthPollRef.current = null; }
    setOauthPending(false);
    setOauth({ busy: false, error: '' });
  };
  const signOut = async (providerId) => {
    const def = LOGIN_PROVIDERS[providerId];
    if (oauthPollRef.current) { clearInterval(oauthPollRef.current); oauthPollRef.current = null; }
    try { if (def) await host[def.logout](); } catch { /* ignore */ }
    setOauthByProvider((m) => ({ ...m, [providerId]: { connected: false, checked: true } }));
    setOauth({ busy: false, error: '' });
    setOauthPending(false);
    refreshModelsRef.current?.(); // the token is gone — drop back to the built-in list
  };
  // The OAuth handlers above are defined before the catalogue fetch (which needs
  // draftCfg); reach it through a ref so neither has to move.
  const refreshModelsRef = useRef(null);
  // Restore the persisted conversation. A proposal left mid-approval is marked
  // not-applied on restore (it was never committed). _mid is advanced past the
  // restored ids so new view items don't collide.
  const _restored = useRef(loadConvo());
  const [messages, setMessages] = useState(() =>
    (_restored.current?.messages || []).map((m) =>
      m.role === 'proposal' && m.status === 'pending' ? { ...m, status: 'rejected' } : m)
  );
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]); // pending image attachments for the NEXT message
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef(null);
  const [busy, setBusy] = useState(false);          // waiting on a model turn
  const [running, setRunning] = useState(false);    // agent loop is active (busy, or between turns/waits) — Stop is shown whenever this is true
  const [pending, setPending] = useState(null);     // a proposal awaiting approve/reject
  // A batch of ask_user questions awaiting answers. The model may emit several
  // in one turn; they are presented ONE AT A TIME (VSCode quick-pick style) and
  // every answer is sent back together when the last one is in.
  //   { calls, answers, idx, otherCalls, turn }
  const [asking, setAsking] = useState(null);
  // Agent mode: 'manual' → every change is shown as a diff to approve/reject;
  // 'auto' → the agent applies changes itself (still rendered as an applied diff).
  const [agentMode, setAgentMode] = useState(() => {
    try { return localStorage.getItem('aiAgentMode') === 'auto' ? 'auto' : 'manual'; } catch { return 'manual'; }
  });
  // Mirror in a ref so runTurn (a useCallback) reads the current mode without a
  // stale closure and without being recreated on every toggle.
  const agentModeRef = useRef(agentMode);
  useEffect(() => {
    agentModeRef.current = agentMode;
    try { localStorage.setItem('aiAgentMode', agentMode); } catch { /* ignore */ }
  }, [agentMode]);
  const scrollRef = useRef(null);
  // The AbortController for the in-flight fetch/wait of the CURRENT turn, and a
  // flag checked between turns so Stop also breaks the auto-continue recursion
  // (read-only turns that chain into the next runTurn with no fetch in flight).
  const turnControllerRef = useRef(null);
  const stopRequestedRef = useRef(false);

  // What the agent is doing right now, and when this run started. A dot
  // animation alone can't be told apart from a hung request — the label + a
  // ticking elapsed time are what actually show it's still alive.
  const [activity, setActivity] = useState('');
  const [runStartedAt, setRunStartedAt] = useState(0);
  const [turnNo, setTurnNo] = useState(0);

  // Every agent run carries a generation. Stop bumps it, which permanently
  // invalidates the in-flight loop: aborting the fetch alone is not enough
  // because the loop recurses BETWEEN turns (read-only turns chain straight
  // into the next runTurn with no request in flight), and because `send()`
  // resets stopRequestedRef — so a stopped loop could otherwise resume and run
  // alongside the new one.
  const runGenRef = useRef(0);

  const stopAgent = () => {
    stopRequestedRef.current = true;
    runGenRef.current++;               // orphan the running loop for good
    turnControllerRef.current?.abort(); // and unblock it if a request is in flight
    // Clear the UI immediately rather than waiting for the loop to notice: if it
    // is parked between turns there is nothing to abort, and "working…" would
    // otherwise stay on screen with no way to dismiss it.
    setBusy(false);
    setRunning(false);
    setActivity('');
    setAsking(null);                   // a blocked question is part of the run
    pushViewRef.current?.({ role: 'note', text: 'Stopped.' });
  };
  // pushView is defined further down (it needs nextId); reach it through a ref
  // so stopAgent doesn't have to move.
  const pushViewRef = useRef(null);
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

  // Rolling ring buffer of timestamped live-variable snapshots while the program
  // runs, so read_live_variables can hand the model a time-series (not just the
  // instantaneous snapshot) to diagnose stuck/oscillating/out-of-range values.
  // Kept in a ref + a lightweight effect so it never triggers heavy re-renders
  // (live values tick every few hundred ms).
  const liveBufRef = useRef([]);
  const LIVE_BUF_MAX = 600; // cap (~minutes at the SSE cadence); auto-trimmed
  useEffect(() => {
    if (!liveVariables || Object.keys(liveVariables).length === 0) return;
    const buf = liveBufRef.current;
    buf.push({ t: Date.now(), v: liveVariables });
    if (buf.length > LIVE_BUF_MAX) buf.splice(0, buf.length - LIVE_BUF_MAX);
  }, [liveVariables]);

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

  // ── live model catalogue for the Connect tab ─────────────────────────────
  // Providers ship models faster than this file gets edited, so the picker asks
  // the provider what it actually serves. The form is WITHHELD until the first
  // fetch settles ("Updating…") — otherwise the stale fallback list is on screen
  // during the fetch and the user picks from it before the real list lands.
  const [modelCat, setModelCat] = useState({ loading: false, settled: false, models: [], error: '' });
  const modelReqRef = useRef(0); // guards against an out-of-order response overwriting a newer one

  const refreshModels = useCallback(async () => {
    const seq = ++modelReqRef.current;
    setModelCat((c) => ({ ...c, loading: true, error: '' }));
    try {
      const r = await host.aiModels({ provider: draftCfg.provider, apiKey: draftCfg.apiKey, baseUrl: draftCfg.baseUrl });
      if (seq !== modelReqRef.current) return;
      setModelCat({ loading: false, settled: true, models: r.models || [], error: r.error || '' });
    } catch (e) {
      if (seq !== modelReqRef.current) return;
      setModelCat({ loading: false, settled: true, models: [], error: e.message || 'could not reach the provider' });
    }
  }, [draftCfg.provider, draftCfg.apiKey, draftCfg.baseUrl]);
  useEffect(() => { refreshModelsRef.current = refreshModels; }, [refreshModels]);

  // Fetch on open and on every provider switch. Deliberately NOT keyed on the
  // API-key/baseUrl keystrokes — refetching per character would hammer the
  // provider; the inline Refresh button covers "I just pasted my key".
  //
  // Only the OPEN gates the form. A provider switch must keep it on screen —
  // hiding the Provider select the user just used would yank the control out
  // from under them — so it refetches with the inline "updating…" instead, and
  // clears `models` so the PREVIOUS provider's list can't linger in the picker.
  const gatedForRef = useRef(null); // non-null once this open has been gated
  useEffect(() => {
    if (!configOpen || cfgTab !== 'connect') { gatedForRef.current = null; return; }
    const firstForThisOpen = gatedForRef.current === null;
    gatedForRef.current = draftCfg.provider;
    setModelCat((c) => ({ loading: true, settled: firstForThisOpen ? false : c.settled, models: [], error: '' }));
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configOpen, cfgTab, draftCfg.provider]);

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

  const [stoppingOllama, setStoppingOllama] = useState(false);
  const stopOllama = async () => {
    setStoppingOllama(true);
    try {
      const r = await host.ollamaStop(ollamaBase);
      if (r?.stopped) {
        setOllama((o) => ({ ...o, running: false, models: [], error: '' }));
        setRuntime(null);
      } else {
        // External daemon (systemd/terminal) — we won't kill it; tell the user.
        setOllama((o) => ({ ...o, error: r?.error || 'Could not stop Ollama.' }));
      }
    } catch (e) {
      setOllama((o) => ({ ...o, error: e.message || 'stop failed' }));
    } finally {
      setStoppingOllama(false);
      refreshOllama();
    }
  };

  // When an Ollama model is active, make sure we know whether the daemon is up
  // (the Download-tab effect only refreshes while that tab is open).
  const activeOllamaModel = config?.provider === 'ollama' ? config.model : null;
  useEffect(() => {
    if (activeOllamaModel && !ollama.checked) refreshOllama();
  }, [activeOllamaModel, ollama.checked, refreshOllama]);

  // Self-heal the header pill: while Ollama is the provider but the daemon is
  // NOT up, re-poll every 4 s so starting `ollama serve` externally flips the
  // pill green without reopening settings. Stops once running (no busy-poll of
  // a healthy daemon — the runtime effect below handles the running case).
  useEffect(() => {
    if (!activeOllamaModel || ollama.running) return;
    const id = setInterval(refreshOllama, 4000);
    return () => clearInterval(id);
  }, [activeOllamaModel, ollama.running, refreshOllama]);

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
  }, [messages, busy, running]);

  // Persist the conversation (view + API history) so it survives the panel
  // unmounting on a tab switch and a full reload. convoRef is updated alongside
  // messages each turn, so saving on messages change captures both.
  useEffect(() => {
    saveConvo(messages, convoRef.current);
  }, [messages]);

  // Auth style of the SAVED provider. Driven off the PROVIDERS table rather than
  // hardcoded ids so a newly added provider gets the right key/sign-in handling
  // from its `auth` field alone. Unknown (legacy config) → treat as key-based.
  const savedAuth = PROVIDERS.find((p) => p.id === config?.provider)?.auth || 'key';
  // A model is SELECTED (settings filled in) — distinct from READY to use.
  const modelSelected = !!(config && config.model && (
    savedAuth === 'local' || savedAuth === 'login' || config.apiKey || config.baseUrl
  ));
  // READY = actually usable right now. A local model additionally needs its
  // daemon reachable (a selected model is useless if `ollama serve` isn't up —
  // the green pill must reflect that, not just that a name was picked); a
  // sign-in provider needs an authenticated session.
  const configured = modelSelected && (
    savedAuth === 'local' ? ollama.running :
    savedAuth === 'login' ? !!oauthByProvider[config?.provider]?.connected :
    true
  );
  // Ollama model chosen but daemon down → amber "selected but not running".
  const ollamaNotRunning = config?.provider === 'ollama' && modelSelected && ollama.checked && !ollama.running;
  // Ollama status not resolved yet — avoid a "No model" flash before the check.
  const ollamaChecking = config?.provider === 'ollama' && modelSelected && !ollama.checked;
  const imagesSupported = IMAGE_CAPABLE_PROVIDERS.has(config?.provider);

  // Validate + add files as pending attachments (paste or the file picker).
  // Non-image files are silently skipped; oversize/over-count are surfaced as
  // a visible error under the input bar instead of a failed network call.
  const addAttachments = async (files) => {
    setAttachError('');
    const images = Array.from(files || []).filter((f) => f.type && f.type.startsWith('image/'));
    if (images.length === 0) return;
    if (attachments.length + images.length > MAX_IMAGES) {
      setAttachError(`Up to ${MAX_IMAGES} images per message.`);
      return;
    }
    const tooBig = images.find((f) => f.size > MAX_IMAGE_BYTES);
    if (tooBig) {
      setAttachError(`"${tooBig.name}" is too large (max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`);
      return;
    }
    try {
      const added = await Promise.all(images.map(fileToAttachment));
      setAttachments((a) => [...a, ...added]);
    } catch (e) {
      setAttachError(e.message || 'Failed to read image.');
    }
  };
  const removeAttachment = (id) => setAttachments((a) => a.filter((x) => x.id !== id));
  const handlePaste = (e) => {
    if (!imagesSupported) return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter(Boolean);
    if (files.length > 0) addAttachments(files);
  };

  const pushView = (item) => setMessages((m) => [...m, { id: nextId(), ...item }]);
  pushViewRef.current = pushView;
  const setViewStatus = (viewId, status) =>
    setMessages((m) => m.map((x) => (x.id === viewId ? { ...x, status } : x)));

  // One model turn: ask the provider for the assistant's next message, run any
  // read tools automatically, and surface write tools as a proposal to approve.
  const runTurn = useCallback(async (apiMessages, turn, gen) => {
    // A stopped (or superseded) run must not emit anything further. stopAgent
    // already cleared the UI and posted "Stopped.", so this just unwinds.
    if (gen !== runGenRef.current) return;
    if (stopRequestedRef.current) {
      stopRequestedRef.current = false;
      setBusy(false);
      setRunning(false);
      setActivity('');
      pushView({ role: 'note', text: 'Stopped.' });
      return;
    }
    if (turn > MAX_AGENT_TURNS) {
      pushView({ role: 'note', text: 'Stopped — too many tool iterations. Ask me to continue if needed.' });
      setRunning(false);
      setActivity('');
      return;
    }
    setBusy(true);
    setTurnNo(turn + 1);
    setActivity('thinking');
    const controller = new AbortController();
    turnControllerRef.current = controller;
    let assistant;
    try {
      assistant = await host.aiChat({
        provider: config.provider, model: config.model, apiKey: config.apiKey, baseUrl: config.baseUrl,
        system: buildSystemPrompt(libraryData, agentModeRef.current),
        context: buildProjectContext(psRef.current, selectedBoard, activeItem),
        messages: providerSafeMessages(apiMessages),
        tools: TOOL_DEFS,
      }, controller.signal);
    } catch (e) {
      // A stop already reported itself and reset the UI — don't double-post.
      if (gen !== runGenRef.current) return;
      setBusy(false);
      setRunning(false);
      setActivity('');
      if (e.name === 'AbortError') {
        stopRequestedRef.current = false;
        pushView({ role: 'note', text: 'Stopped.' });
      } else {
        pushView({ role: 'note', text: `Error: ${e.message}` });
      }
      return;
    }
    if (gen !== runGenRef.current) return; // stopped while the request was in flight
    setBusy(false);
    setActivity('applying');

    let calls = assistant.toolCalls || [];
    let assistantText = stripSpecialTokens(assistant.content || '');
    // Fallback: a model that wrote the tool call as text instead of using the
    // structured field. Promote it to a real call and don't show it as prose.
    // ⚠️ Gated to providers that actually need it. These layers exist for weak
    // LOCAL models that print a call instead of emitting one; a native
    // tool-calling provider that returns text-only is simply DONE, and treating
    // its closing summary as a missed call is a misread. Observed: Gemini
    // finished the job, replied "I have created … ```iecst …```", and
    // recoverStCodeBlock re-applied that summary as a fresh set_st_code — which
    // then poisoned the transcript (see providerSafeMessages).
    if (calls.length === 0 && recoverToolCallsFromText(config.provider)) {
      const inline = extractInlineToolCalls(assistantText);
      if (inline) { calls = inline; assistantText = ''; }
    }
    // Some models emit calls as `tool_name key="value"` plain text (no JSON).
    if (calls.length === 0 && recoverToolCallsFromText(config.provider)) {
      const kv = extractKeyValToolCalls(assistantText);
      if (kv) { calls = kv; assistantText = ''; }
    }
    // Last-ditch fallback: a weak model that, after several turns, stops calling
    // tools and just PRINTS the POU body in a ```st code block. Recover it as a
    // set_st_code on the active POU (the POU-target inference fills the target).
    if (calls.length === 0 && recoverToolCallsFromText(config.provider)) {
      const codeCall = recoverStCodeBlock(assistantText);
      if (codeCall) { calls = codeCall; assistantText = ''; }
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

    if (calls.length === 0) { setRunning(false); return; } // final answer, loop ends

    // ── ask_user: pause the loop for a human ────────────────────────────────
    // Intercepted BEFORE the applyToolCall dispatch: it is the one tool whose
    // result comes from the user, not from the project struct. Every ask_user
    // in this turn is queued and asked one at a time; anything else the model
    // bundled alongside is refused with an explanation, so a turn is either
    // "ask" or "act" and we never have to gate a question and a diff at once.
    const askCalls = calls.filter((c) => c.name === 'ask_user');
    if (askCalls.length > 0) {
      const otherCalls = calls.filter((c) => c.name !== 'ask_user');
      setAsking({
        calls: askCalls.map((c) => ({ tc: c, args: parseArgs(c.arguments) || {} })),
        answers: [], idx: 0, otherCalls, turn,
      });
      setRunning(false);   // waiting on a human — no clock, no Stop spinner
      setActivity('');
      return;
    }

    // Dry-run every call in order, chaining mutations through a working copy so
    // composed diffs (e.g. add_variable then set_st_code) are computed correctly.
    let working = workingRef.current;
    const steps = [];
    // Weak models routinely omit (or garble) the `pou` field on a local-scope
    // variable/code call even right after create_pou — so the var never lands
    // and the rung/body references an undefined name. Infer the intended target
    // from turn context: the POU touched last → the single POU created this turn
    // → the open POU. We only override when the model's `pou` doesn't resolve.
    const createdThisTurn = calls
      .filter((c) => c.name === 'create_pou')
      .map((c) => parseArgs(c.arguments)?.name).filter(Boolean);
    const singleCreated = createdThisTurn.length === 1 ? createdThisTurn[0] : null;
    let lastPou = null;
    const inferPou = () => {
      for (const cand of [lastPou, singleCreated, activeItem?.name]) {
        if (cand && findPOU(working, cand)) return cand;
      }
      return null;
    };
    for (const tc of calls) {
      const args = parseArgs(tc.arguments);
      if (args.__parseError) { steps.push({ tc, args: {}, res: { ok: false, error: 'arguments were not valid JSON' } }); continue; }
      if (tc.name === 'get_project_overview') args.__board = selectedBoard;
      if (tc.name === 'read_live_variables') args.__live = { current: liveVariables, history: summarizeLiveSamples(liveBufRef.current) };
      if (tc.name === 'watch_live_variables') {
        // Active observation: actually WAIT real time so fresh samples land in
        // liveBufRef (the SSE effect keeps filling it during this await), then
        // summarize each variable over its own trailing window. The loop is
        // async, so awaiting here pauses only this turn — not the whole app.
        const running = liveVariables && Object.keys(liveVariables).length > 0;
        if (!running) {
          args.__watch = { running: false };
        } else {
          const specs = Array.isArray(args.variables) ? args.variables : [];
          const durs = specs.map((s) => Number(s?.seconds)).filter((n) => n > 0);
          // No upper cap — the model picks whatever window the behaviour under
          // diagnosis actually needs (a slow ramp may genuinely take minutes).
          // Stop is always available to cut a watch short if it picks badly.
          let wait = Number(args.maxSeconds) > 0 ? Number(args.maxSeconds) : (durs.length ? Math.max(...durs) : 5);
          wait = Math.max(1, wait);
          const names = specs.map((s) => s?.name).filter(Boolean).join(', ') || 'live variables';

          // Live-ticking note so the user can see logging is actually in
          // progress and for how long, not just a static "thinking" spinner.
          const watchViewId = nextId();
          const startTs = Date.now();
          const elapsedText = () => {
            const elapsed = Math.floor((Date.now() - startTs) / 1000);
            return `📡 Logging ${names} — ${elapsed}s / ${wait}s elapsed…`;
          };
          setMessages((m) => [...m, { id: watchViewId, role: 'note', text: elapsedText() }]);
          const tickId = setInterval(() => {
            setMessages((m) => m.map((x) => (x.id === watchViewId ? { ...x, text: elapsedText() } : x)));
          }, 1000);

          try {
            setActivity('watching live variables');
            await sleepAbortable(wait * 1000, controller.signal);
            args.__watch = { running: true, waitedSeconds: wait, history: summarizeWatch(liveBufRef.current, specs) };
          } catch {
            // Stop was pressed mid-watch — abandon this turn entirely below.
          } finally {
            setActivity('applying');
            clearInterval(tickId);
            const finalElapsed = Math.floor((Date.now() - startTs) / 1000);
            setMessages((m) => m.map((x) => (x.id === watchViewId
              ? { ...x, text: `📡 Logged ${names} for ${finalElapsed}s.` }
              : x)));
          }
        }
      }
      if (controller.signal.aborted) break;
      // Tools that need the standard block library: list_blocks (catalog) and
      // set_ladder (FB pin resolution for fb-in-rung).
      if (tc.name === 'list_blocks' || tc.name === 'set_ladder') args.__library = libraryData;
      // Repair a missing/unresolvable local-scope POU target from context.
      if (needsLocalPou(tc.name, args) && !findPOU(working, args.pou)) {
        const inferred = inferPou();
        if (inferred) args.pou = inferred;
      }
      const res = applyToolCall(working, tc.name, args);
      if (res.mutation && res.ok) {
        working = res.next;
        // Track the most recently touched POU so later calls in this turn that
        // omit `pou` resolve to it (e.g. create_pou → add_variable → set_ladder).
        if (tc.name === 'create_pou') lastPou = args.name;
        else if (tc.name === 'rename_pou' && args.newName) lastPou = args.newName;
        else if (args.pou) lastPou = args.pou;
      }
      steps.push({ tc, args, res });
    }

    if (controller.signal.aborted) {
      setRunning(false);
      pushView({ role: 'note', text: 'Stopped.' });
      return;
    }

    const hasMutations = steps.some((s) => s.res?.mutation && s.res.ok);
    if (!hasMutations) {
      // Reads / errors only — feed results back and keep going automatically.
      const toolMsgs = steps.map(toolResultMessage);
      runTurn([...convoRef.current, ...toolMsgs], turn + 1, gen);
      return;
    }

    const viewId = nextId();
    // AUTO mode: apply the change ourselves and keep the loop going — no gate.
    // The turn is still rendered as an (already-applied) diff for transparency.
    if (agentModeRef.current === 'auto') {
      setMessages((m) => [...m, { id: viewId, role: 'proposal', steps, status: 'approved' }]);
      commitTurn(steps, working);
      const toolMsgs = steps.map((s) => toolResultMessage({ ...s, outcome: 'applied' }));
      runTurn([...convoRef.current, ...toolMsgs], turn + 1, gen);
      return;
    }
    // MANUAL mode: pause for approval. dryStruct is the fully-composed result.
    setMessages((m) => [...m, { id: viewId, role: 'proposal', steps, status: 'pending' }]);
    setPending({ steps, dryStruct: working, viewId, turn });
    setRunning(false);
  }, [config, selectedBoard, activeItem, liveVariables]);

  // Commit a turn's composed result into the live project and push it online if
  // a hot-swap session is active. Shared by AUTO mode and manual approval.
  const commitTurn = (steps, dryStruct) => {
    setProjectStructure && setProjectStructure(dryStruct);
    workingRef.current = dryStruct;
    const touched = affectedPOUs(steps);
    // Pass the committed structure + the POU to focus so App can open it on
    // screen (race-free: don't rely on App's not-yet-updated state).
    onApplied && onApplied(touched, { structure: dryStruct, focus: focusTarget(steps) });
    // If a hot-swap session is live, push the change online (App decides
    // whether a swap is possible or a cold restart is needed).
    onHotSwap && onHotSwap(touched);
  };

  const send = (text) => {
    const prompt = (text ?? input).trim();
    const imgs = attachments;
    if ((!prompt && imgs.length === 0) || running || pending || asking) return;
    setInput('');
    setAttachments([]);
    setAttachError('');
    if (!configured) {
      pushView({ role: 'user', text: prompt, images: imgs });
      pushView({ role: 'note', text: ollamaNotRunning
        ? `Ollama is not running, so "${config.model}" can't respond. Open the ⚙ settings → Download & Setup and start Ollama, then ask again.`
        : 'No model configured yet. Click the ⚙ gear above to connect a model, then ask again.' });
      return;
    }
    pushView({ role: 'user', text: prompt, images: imgs });
    // Start a fresh agent run from the latest committed project state.
    workingRef.current = psRef.current;
    stopRequestedRef.current = false;
    setRunning(true);
    setRunStartedAt(Date.now());
    setActivity('thinking');
    const userMsg = { role: 'user', content: prompt };
    if (imgs.length > 0) userMsg.images = imgs.map((a) => ({ mimeType: a.mimeType, data: a.data }));
    const apiMessages = [...convoRef.current, userMsg];
    // A fresh generation: anything still unwinding from a previous run is now
    // stale and will bail instead of interleaving with this one.
    runTurn(apiMessages, 0, ++runGenRef.current);
  };

  // "Ask agent" from the output-panel error popup: send the prompt once per
  // request id. If the agent is mid-turn or a proposal is pending, send() bails
  // but leaves the text in the input box (fallback) so nothing is lost.
  const lastAskIdRef = useRef(null);
  useEffect(() => {
    if (!askRequest || askRequest.id === lastAskIdRef.current) return;
    lastAskIdRef.current = askRequest.id;
    const text = (askRequest.text || '').trim();
    if (!text) return;
    setInput(text);
    send(text);
  }, [askRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolvePending = (approved) => {
    if (!pending) return;
    const { steps, dryStruct, viewId, turn } = pending;
    if (approved) commitTurn(steps, dryStruct);
    setViewStatus(viewId, approved ? 'approved' : 'rejected');
    const toolMsgs = steps.map((s) => toolResultMessage({ ...s, outcome: approved ? 'applied' : 'rejected' }));
    setPending(null);
    // ⚠️ The loop RESUMES here, so the run state has to come back on. Without
    // this the agent kept working after an approval while the UI showed nothing
    // running and offered no Stop button. The clock restarts from the resume
    // rather than the original send, so it measures work and not how long the
    // proposal sat waiting for a human.
    stopRequestedRef.current = false;
    setRunning(true);
    setRunStartedAt(Date.now());
    setActivity('thinking');
    runTurn([...convoRef.current, ...toolMsgs], turn + 1, ++runGenRef.current);
  };

  // One answer to the current ask_user question. Advances to the next question,
  // or — when the last one is answered — feeds every answer back and resumes.
  const answerAsk = (text) => {
    const answer = String(text ?? '').trim();
    if (!asking || !answer) return;
    const { calls, answers, idx, otherCalls, turn } = asking;
    const nextAnswers = [...answers, answer];
    pushView({ role: 'answer', question: calls[idx].args.question || '', text: answer });
    if (idx + 1 < calls.length) { setAsking({ ...asking, answers: nextAnswers, idx: idx + 1 }); return; }

    setAsking(null);
    // Every tool_call_id in the assistant turn MUST get a result or the next
    // request is rejected by the provider — including the calls we refused.
    const toolMsgs = [
      ...calls.map((c, i) => toolResultMessage({
        tc: c.tc, args: c.args, res: { ok: true, result: { answer: nextAnswers[i] } },
      })),
      ...otherCalls.map((c) => toolResultMessage({
        tc: c, args: parseArgs(c.arguments) || {},
        res: { ok: false, error: 'not executed — this turn contained ask_user, so only the questions ran. Re-issue this call now that you have the answers.' },
      })),
    ];
    stopRequestedRef.current = false;
    setRunning(true);
    setRunStartedAt(Date.now());
    setActivity('thinking');
    runTurn([...convoRef.current, ...toolMsgs], turn + 1, ++runGenRef.current);
  };

  // Abandoning a question ends the run — the model cannot proceed without it,
  // and silently answering "skip" for them would put a guess in the transcript.
  const cancelAsk = () => {
    if (!asking) return;
    setAsking(null);
    runGenRef.current++;
    setRunning(false);
    setActivity('');
    pushView({ role: 'note', text: 'Stopped — question left unanswered.' });
  };

  const resetChat = () => {
    if (running) return;
    convoRef.current = [];
    liveBufRef.current = [];           // drop buffered live samples for the fresh chat
    setPending(null);
    setAsking(null);
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
  const loginDef = LOGIN_PROVIDERS[draftCfg.provider] || null;
  // Live catalogue when the provider answered; the built-in list only as a
  // fallback (no key yet, daemon down, endpoint without a /models route).
  const modelSuggestions = modelCat.models.length ? modelCat.models : providerDef.models;

  return (
    // Claim the interaction scope so the sidebar/LD global Ctrl+C handlers bail
    // instead of copying a POU while the user is working in the chat. (Belt and
    // braces — hasTextSelection() already covers the copy-selected-text case.)
    <div onMouseDownCapture={() => setEditorScope(EDITOR_SCOPE.AGENT)}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%', background: C.bg, color: C.text, fontSize: 12 }}>
      {/* ── header: title + model pill + gear ─────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 13 }}>🤖</span>
        <span style={{ fontWeight: 600, marginRight: 'auto' }}>PLC Agent</span>
        {/* mode toggle: Manual (approve each change) vs Auto (agent applies directly) */}
        <div style={{ display: 'flex', background: C.input, border: `1px solid ${C.border2}`, borderRadius: 10, padding: 1 }}>
          {[['manual', 'Manual', 'Review and approve every change'], ['auto', 'Auto', 'The agent applies changes automatically']].map(([id, lbl, tip]) => (
            <button key={id} onClick={() => setAgentMode(id)} title={tip}
              style={{ background: agentMode === id ? (id === 'auto' ? '#7a4a12' : C.accentBtn) : 'transparent', border: 'none', color: agentMode === id ? '#fff' : C.sub, fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 9, cursor: 'pointer' }}>
              {lbl}
            </button>
          ))}
        </div>
        {activeOllamaModel && <RuntimeBadge rt={runtime} />}
        <button
          onClick={() => { setDraftCfg(config || draftCfg); setConfigOpen(o => !o); }}
          title={ollamaNotRunning ? 'Ollama is not running — open settings → Download & Setup to start it' : 'Model settings'}
          style={{ background: configured ? '#1e3a2a' : (ollamaNotRunning ? '#3a2e12' : 'transparent'), border: `1px solid ${configured ? '#2e5a3e' : (ollamaNotRunning ? '#7a5a1a' : C.border2)}`, color: configured ? C.green : (ollamaNotRunning ? '#e0a94f' : C.sub), fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, maxWidth: 170 }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: configured ? C.green : (ollamaNotRunning ? '#e0a94f' : '#777'), flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {configured ? config.model
              : ollamaNotRunning ? `${config.model} (off)`
              : ollamaChecking ? config.model
              : 'No model'}
          </span>
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
              onStop={stopOllama} stopping={stoppingOllama}
            />
          ) : !modelCat.settled ? (
            /* First fetch still in flight — withhold the form rather than show a
               stale model list the user might pick from before the real one lands. */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 8px', color: C.sub, fontSize: 12 }}>
              <span className="agent-think-dots" aria-hidden="true"><i /><i /><i /></span>
              <span>Updating available models…</span>
            </div>
          ) : (
          <>
          <label style={{ fontSize: 11, color: C.sub }}>Provider</label>
          <select value={draftCfg.provider} onChange={e => switchProvider(e.target.value)}
            style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px' }}>
            {/* Grouped so "sign in with my subscription" and "paste an API key"
                are visibly different choices — they were an undifferentiated
                flat list, so the account sign-in read as just another vendor. */}
            {AUTH_GROUPS.map(([kind, title]) => {
              const items = PROVIDERS.filter((p) => p.auth === kind);
              return items.length ? (
                <optgroup key={kind} label={title}>
                  {items.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label style={{ fontSize: 11, color: C.sub }}>Model</label>
            {modelCat.loading && <span style={{ fontSize: 10, color: C.muted }}>updating…</span>}
            <button type="button" onClick={refreshModels} disabled={modelCat.loading} title="Re-read the provider's model list"
              style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '1px 7px', borderRadius: 3, cursor: modelCat.loading ? 'default' : 'pointer' }}>
              ⟳ Refresh
            </button>
          </div>
          <ModelPicker value={draftCfg.model} options={modelSuggestions}
            onChange={(m) => setDraftCfg(d => ({ ...d, model: m }))} />
          {/* Say plainly whether the list is LIVE or the built-in fallback — the
              two look identical in the dropdown, and picking a model the
              provider doesn't serve only fails later, mid-conversation. */}
          {modelCat.error ? (
            <span style={{ fontSize: 9, color: '#e0a94f' }}>
              Live list unavailable ({modelCat.error}) — showing built-in suggestions.
              {draftCfg.provider === 'ollama' ? ' Start the daemon in Download & Setup, then Refresh.'
                : providerDef.auth === 'login' ? ' Sign in below, then Refresh.'
                : ' Add your API key, then Refresh.'}
            </span>
          ) : modelCat.models.length === 0 ? (
            <span style={{ fontSize: 9, color: '#e0a94f' }}>
              {draftCfg.provider === 'ollama'
                ? 'No models pulled yet — grab one in Download & Setup. Suggestions below are pullable tags.'
                : 'This provider returned no usable chat models — showing built-in suggestions.'}
            </span>
          ) : (
            <span style={{ fontSize: 9, color: '#777' }}>{modelCat.models.length} chat models available — live from this provider.</span>
          )}
          {providerDef.auth === 'login' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: C.code, border: `1px solid ${C.border2}`, borderRadius: 4, padding: 8 }}>
              {loginDef && oauthByProvider[draftCfg.provider]?.connected ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: C.green }}>{loginDef.signedIn}</span>
                  <button onClick={() => signOut(draftCfg.provider)} style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer' }}>Sign out</button>
                </div>
              ) : !oauthPending ? (
                <>
                  <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
                    {loginDef?.blurb}
                  </div>
                  <button onClick={() => startSignIn(draftCfg.provider)} disabled={oauth.busy}
                    style={{ alignSelf: 'flex-start', background: C.accentBtn, border: 'none', color: '#fff', fontSize: 11, padding: '5px 12px', borderRadius: 3, cursor: 'pointer' }}>
                    {oauth.busy ? 'Opening…' : loginDef?.button}
                  </button>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: C.sub }}>⏳ Waiting for you to authorize in the browser… (connects automatically)</span>
                  <button onClick={cancelSignIn}
                    style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer' }}>Cancel</button>
                </div>
              )}
              {oauth.error && <span style={{ fontSize: 9, color: '#e06c75' }}>{oauth.error}</span>}
              <span style={{ fontSize: 9, color: '#777' }}>{loginDef?.note}</span>
            </div>
          ) : providerDef.auth !== 'local' && (   /* key + custom take an API key; local takes none */
            <>
              <label style={{ fontSize: 11, color: C.sub }}>API key</label>
              <PasswordInput value={draftCfg.apiKey} onChange={e => setDraftCfg(d => ({ ...d, apiKey: e.target.value }))} placeholder="sk-..."
                iconColor={C.sub}
                showTitle="Show API key" hideTitle="Hide API key"
                style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace' }} />
            </>
          )}
          {(providerDef.auth === 'custom' || providerDef.auth === 'local') && (
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
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {/* Inner content column: the OUTER div is a plain block that scrolls; if
            the outer were a flex column, its children (bubbles, the tall proposal
            card) would flex-shrink to fit and clip instead of overflowing — so
            you couldn't scroll to the Approve/Reject buttons. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100%' }}>
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
        {running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="agent-think-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="agent-think-label">
                {(activity || (busy ? 'thinking' : 'working'))}…
              </span>
            </span>
            {/* Ticking elapsed + turn counter: this is what distinguishes "still
                working" from "hung". Isolated in its own component so the 1s
                tick re-renders ~20 characters, not the whole message list. */}
            <span style={{ fontSize: 10, color: C.muted }}>
              <ElapsedTimer since={runStartedAt} />{turnNo > 1 ? ` · step ${turnNo}` : ''}
            </span>
            <button onClick={stopAgent} title="Stop the agent"
              style={{ background: 'transparent', border: `1px solid ${C.border2}`, color: '#e06c75', fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: 'pointer' }}>
              ■ Stop
            </button>
          </div>
        )}
        </div>
      </div>

      {/* ── ask_user prompt ───────────────────────────────────────────────
          ⚠️ Deliberately OUTSIDE the scrolling message list, directly above the
          input bar — same rule as the Stop button. A question the run is
          blocked on must never be able to scroll out of view; in a long
          conversation the agent would just look hung. */}
      {asking && (
        <AskCard
          spec={asking.calls[asking.idx].args}
          index={asking.idx} total={asking.calls.length}
          onAnswer={answerAsk} onCancel={cancelAsk}
        />
      )}

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
            <button onClick={resetChat} disabled={running} title="New chat (also clears the agent log)"
              style={{ background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: running ? 'default' : 'pointer' }}>
              ＋ New chat
            </button>
          )}
        </div>
        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, background: C.input, padding: 6, opacity: (pending || asking) ? 0.55 : 1 }}>
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {attachments.map((a) => (
                <div key={a.id} style={{ position: 'relative' }}>
                  <img src={a.previewUrl} alt={a.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, border: `1px solid ${C.border2}` }} />
                  <button onClick={() => removeAttachment(a.id)} title="Remove"
                    style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: '#c62828', color: '#fff', border: 'none', fontSize: 9, lineHeight: 1, cursor: 'pointer' }}>✕</button>
                </div>
              ))}
            </div>
          )}
          {attachError && <div style={{ fontSize: 10, color: '#e06c75', marginBottom: 6 }}>{attachError}</div>}
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              // Esc stops a running agent from the box you're already typing in
              // (VSCode-style) — no hunting for the button.
              if (e.key === 'Escape' && running) { e.preventDefault(); stopAgent(); return; }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            onPaste={handlePaste}
            placeholder={pending ? 'Approve or reject the proposed changes first…'
              : asking ? 'Answer the question above…' : 'Describe the change you want…'}
            rows={2}
            disabled={!!pending || !!asking}
            style={{ width: '100%', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: C.text, fontSize: 12, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={(e) => { addAttachments(e.target.files); e.target.value = ''; }} />
            <button onClick={() => fileInputRef.current?.click()} disabled={!imagesSupported || running || !!pending || !!asking}
              title={imagesSupported ? 'Attach an image' : 'This provider does not support image input'}
              style={{ background: 'transparent', border: `1px solid ${C.border2}`, color: imagesSupported ? C.sub : '#555', fontSize: 12, width: 26, height: 26, borderRadius: 4, cursor: imagesSupported ? 'pointer' : 'not-allowed' }}>
              🖼
            </button>
            {/* While running, show what it's doing right here in the input bar.
                The in-thread indicator scrolls away in a long conversation —
                this one can't, which is the point. */}
            {running ? (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: C.sub }}>
                <span className="agent-think-dots" aria-hidden="true"><i /><i /><i /></span>
                {(activity || 'working')}… <ElapsedTimer since={runStartedAt} />
              </span>
            ) : (
              <span style={{ marginLeft: 'auto', fontSize: 10, color: '#666' }}>↵ send · ⇧↵ newline</span>
            )}
            {/* ⚠️ VSCode-style: while the agent runs, the SEND button becomes
                STOP. Stop used to live only at the bottom of the scrolling
                message list, so in a long conversation it was below the fold —
                the agent looked unstoppable because the control was off-screen.
                Keep this control in the input bar; it must never scroll away. */}
            {running ? (
              <button onClick={stopAgent} title="Stop the agent (Esc)"
                style={{ background: '#5a1e1e', border: '1px solid #8b3a3a', color: '#ff9b9b', width: 26, height: 26, borderRadius: 4, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ■
              </button>
            ) : (
              <button onClick={() => send()} disabled={(!input.trim() && attachments.length === 0) || !!pending || !!asking}
                style={{ background: (input.trim() || attachments.length > 0) && !pending && !asking ? C.accentBtn : '#333', border: 'none', color: (input.trim() || attachments.length > 0) && !pending && !asking ? '#fff' : '#777', width: 26, height: 26, borderRadius: 4, cursor: (input.trim() || attachments.length > 0) && !pending && !asking ? 'pointer' : 'default', fontSize: 13 }}>
                ➤
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ask_user question card (VSCode quick-pick) ──────────────────────────────
// Two shapes, chosen by the model: with `options` it is a list of clickable
// choices; without, a single focused text box. Either way ONE question at a
// time — the old behaviour was a numbered list of 3 questions in a chat bubble
// that the user had to read and answer in prose.
function AskCard({ spec, index, total, onAnswer, onCancel }) {
  const [other, setOther] = useState('');
  const boxRef = useRef(null);
  const options = Array.isArray(spec?.options) ? spec.options.filter((o) => o && o.label) : [];
  const allowOther = spec?.allowOther !== false;   // default: never box the user in
  const freeText = options.length === 0;
  // Autofocus so a text answer is typed immediately and Esc/Enter work without
  // a click. Re-runs per question so the next one in the queue grabs focus too.
  useEffect(() => { boxRef.current?.focus(); setOther(''); }, [index]);

  const submitOther = () => { const v = other.trim(); if (v) onAnswer(v); };

  return (
    <div style={{ borderTop: `1px solid ${C.border}`, background: '#1b2430', padding: '10px 10px 8px', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 7 }}>
        <span style={{ fontSize: 10, color: '#6aa9e0', letterSpacing: 0.4 }}>QUESTION</span>
        {total > 1 && <span style={{ fontSize: 10, color: C.muted }}>{index + 1} / {total}</span>}
        <button onClick={onCancel} title="Cancel — ends the run"
          style={{ marginLeft: 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '1px 8px', borderRadius: 10, cursor: 'pointer' }}>
          Cancel
        </button>
      </div>
      <div style={{ fontSize: 12, color: C.text, marginBottom: 8, whiteSpace: 'pre-wrap' }}>{spec?.question || '…'}</div>

      {!freeText && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: allowOther ? 8 : 0 }}>
          {options.map((o, i) => (
            <button key={i} ref={i === 0 ? boxRef : null} onClick={() => onAnswer(o.label)}
              style={{ textAlign: 'left', background: C.input, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '6px 9px', borderRadius: 4, cursor: 'pointer' }}>
              {o.label}
              {o.description && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{o.description}</div>}
            </button>
          ))}
        </div>
      )}

      {(freeText || allowOther) && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            ref={freeText ? boxRef : null}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitOther(); }
              if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            placeholder={freeText ? 'Type your answer…' : 'Other… (type your own answer)'}
            style={{ flex: 1, background: C.input, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '5px 8px', borderRadius: 4, outline: 'none' }}
          />
          <button onClick={submitOther} disabled={!other.trim()}
            style={{ background: other.trim() ? C.accentBtn : '#333', border: 'none', color: other.trim() ? '#fff' : '#777', fontSize: 12, padding: '5px 12px', borderRadius: 4, cursor: other.trim() ? 'pointer' : 'default' }}>
            ➤
          </button>
        </div>
      )}
    </div>
  );
}

// Ticking "how long has it been working" readout. Owns its own interval so the
// 1s tick re-renders only this span — putting the timer in the panel's state
// would re-render the whole message list (and every ProposalCard) every second.
const secsSince = (since) => (since ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0);
function ElapsedTimer({ since }) {
  // Seeded from `since` rather than 0: the timer also mounts mid-run (the
  // indicator appears/disappears with `running`), and starting at 0 would make
  // an agent that has been working for a minute look like it just began.
  const [secs, setSecs] = useState(() => secsSince(since));
  useEffect(() => {
    if (!since) { setSecs(0); return; }
    const tick = () => setSecs(secsSince(since));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [since]);
  return <span>{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`}</span>;
}

// ── model picker (dark-theme, select-only) ──────────────────────────────────
// ⚠️ SELECT-ONLY, and opening it must always reveal the WHOLE list.
// This was previously an editable combo whose text box doubled as the filter.
// Since that box also held the CURRENT selection, opening it filtered the list
// down to entries containing the already-selected name — so a user on
// "claude-opus-4-8" saw only that one and could not reach any other model.
// A native <select> (same styling as the Provider field above) fixes it
// structurally: click shows everything, plus keyboard nav and type-ahead.
// Do NOT reintroduce free-text-as-filter here.
function ModelPicker({ value, options = [], onChange }) {
  // A saved model the provider no longer lists must remain selectable — without
  // this, opening settings would silently switch the user to whatever option
  // happens to render first, and Save would persist that.
  const list = value && !options.includes(value) ? [value, ...options] : options;

  // Nothing to choose from (a custom gateway with no /models route, or a
  // provider that returned an empty list) — typing is then the ONLY way to
  // configure anything, so the escape hatch survives exactly where it's needed.
  if (list.length === 0) {
    return (
      <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="model name"
        style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px', fontFamily: 'monospace' }} />
    );
  }
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)}
      style={{ background: C.panel, border: `1px solid ${C.border2}`, color: C.text, fontSize: 12, padding: '4px 6px' }}>
      {!value && <option value="" disabled>Select a model…</option>}
      {list.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}

// ── message bubble (user / assistant / note) ─────────────────────────────────
function Bubble({ msg }) {
  if (msg.role === 'note') {
    return <div style={{ fontSize: 11, color: C.muted, fontStyle: 'italic', textAlign: 'center' }}>{msg.text}</div>;
  }
  // An answered ask_user question — keep the QUESTION next to the answer so the
  // transcript still reads as a conversation once the card is gone.
  if (msg.role === 'answer') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
        {msg.question && <div style={{ fontSize: 10, color: C.muted, maxWidth: '92%' }}>{msg.question}</div>}
        <div style={{ maxWidth: '92%', background: C.user, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '5px 10px', fontSize: 12, lineHeight: 1.45 }}>
          {msg.text}
        </div>
      </div>
    );
  }
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{ fontSize: 10, color: C.muted }}>{isUser ? 'You' : 'Agent'}</div>
      <div style={{ maxWidth: '92%', background: isUser ? C.user : C.input, border: `1px solid ${C.border2}`, borderRadius: 6, padding: '7px 10px', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
        {msg.images && msg.images.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: msg.text ? 6 : 0, flexWrap: 'wrap' }}>
            {msg.images.map((img, i) => (
              <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="attachment"
                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, border: `1px solid ${C.border2}` }} />
            ))}
          </div>
        )}
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
            style={{ flex: 1, background: '#3a1e1e', border: '1px solid #5a2e2e', color: '#e06c75', fontSize: 12, padding: '5px 0', borderRadius: 3, cursor: 'pointer' }}>
            ✕ Reject
          </button>
        </div>
      )}
    </div>
  );
}

// ── local-model (Ollama) download & setup catalog ───────────────────────────
function OllamaCatalog({ ollama, pulls, setup, runtime, installedSet, activeModel, baseUrl, onBaseUrl, onRefresh, onSetup, onPull, onUse, onUnload, onStop, stopping }) {
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
        {ollama.running && onStop && (
          <button onClick={onStop} disabled={stopping} title="Stop the editor-managed Ollama daemon"
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #7a2e2e', color: '#e06c75', fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: stopping ? 'default' : 'pointer' }}>
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}
        <button onClick={onRefresh} title="Refresh"
          style={{ marginLeft: ollama.running && onStop ? 0 : 'auto', background: 'transparent', border: `1px solid ${C.border2}`, color: C.sub, fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer' }}>
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
