import './style.css';
import yaml from 'js-yaml';
import { Engine, ContextContractSchema, diffContracts } from '../../dist/src/index.js';
import type { ContextContract, Tokenizer } from '../../dist/src/index.js';

// gpt-tokenizer ships the full BPE vocabulary (~2 MB), so load it only on demand.
let gptTok: Tokenizer | null = null;
async function ensureGptTokenizer(): Promise<Tokenizer> {
  if (!gptTok) {
    const mod = await import('../../dist/src/adapters/gpt-tokenizer.js');
    gptTok = mod.gptTokenizer;
  }
  return gptTok;
}

const DEFAULT_CONTRACT = `version: "1.0.0"
name: "CodeReviewAgentContract"
maxTotalTokens: 600

slots:
  - name: "system"
    source: "static"
    priority: 0
    immutable: true
    compaction: "error"
    required: true
  - name: "guidelines"
    source: "static"
    priority: 1
    compaction: "error"
    maxTokens: 200
    required: true
  - name: "changed_code"
    source: "dynamic"
    priority: 2
    compaction: "summarize"
    maxTokens: 300
    required: true
  - name: "user_message"
    source: "dynamic"
    priority: 3
    compaction: "truncate"
    required: true

rules:
  - name: "no-secrets-allowed"
    type: "regex"
    targetSlot: "changed_code"
    pattern: "(api_key|password|client_secret)\\\\s*=\\\\s*['\\"][a-zA-Z0-9-_]{16,}['\\"]"
    negate: true
    severity: "error"
    message: "Posible secreto hardcodeado en el diff."
  - name: "check-refs"
    type: "broken-ref"
    targetSlot: "user_message"
    severity: "warning"
`;

const DEFAULT_INPUTS: Record<string, string> = {
  system: 'You are a Senior Code Reviewer agent. Analyze diffs for bugs, performance and design issues. Output clean markdown.',
  guidelines: 'Prefer pure functions. No hardcoded secrets. Keep functions small and well-named.',
  changed_code: `diff --git a/src/db.js b/src/db.js
@@ export function connect() {
   const dbUri = process.env.DATABASE_URL;
   return new DatabaseClient(dbUri);
 }
+// using env, no hardcoded credentials`,
  user_message: 'Review this change following {guidelines}; flag anything risky.'
};

// --- DOM helpers -----------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

// --- State -----------------------------------------------------------------
interface UIState {
  contract: string;
  inputs: Record<string, string>;
  tokenizer: string;
  interpolate: boolean;
  budget: number | null; // null = follow the contract's maxTotalTokens
}

const inputState: Record<string, string> = { ...DEFAULT_INPUTS };
let renderedSlots: string[] = [];
let budgetTouched = false;
let lastPayload = ''; // raw assembled content, for the copy button

const contractEl = $<HTMLTextAreaElement>('contract');
const tokenizerEl = $<HTMLSelectElement>('tokenizer');
const interpolateEl = $<HTMLInputElement>('interpolate');
const budgetEl = $<HTMLInputElement>('budget');
const inputsEl = $('inputs');

const LS_KEY = 'hcc-playground-state';

function getState(): UIState {
  return {
    contract: contractEl.value,
    inputs: { ...inputState },
    tokenizer: tokenizerEl.value,
    interpolate: interpolateEl.checked,
    budget: budgetTouched ? Number(budgetEl.value) : null
  };
}

function applyState(s: UIState) {
  contractEl.value = s.contract;
  for (const k of Object.keys(inputState)) delete inputState[k];
  Object.assign(inputState, s.inputs || {});
  tokenizerEl.value = s.tokenizer || 'heuristic';
  interpolateEl.checked = !!s.interpolate;
  if (typeof s.budget === 'number') { budgetTouched = true; budgetEl.value = String(s.budget); }
  else { budgetTouched = false; }
  renderedSlots = []; // force input fields to rebuild with new values
  run();
}

function encodeState(s: UIState): string {
  return btoa(encodeURIComponent(JSON.stringify(s)));
}
function decodeState(str: string): UIState | null {
  try { return JSON.parse(decodeURIComponent(atob(str))) as UIState; } catch { return null; }
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(getState())); } catch { /* ignore */ }
}
function loadLocal(): UIState | null {
  try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) as UIState : null; } catch { return null; }
}

let toastTimer: number | undefined;
function toast(msg: string) {
  let t = document.getElementById('toast');
  if (!t) { t = div('toast'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 1800);
}

// --- Core ------------------------------------------------------------------
function parseContractText(text: string): { contract?: ContextContract; error?: string } {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (e: any) {
    return { error: 'YAML inválido: ' + e.message };
  }
  const parsed = ContextContractSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `Esquema inválido: ${first.path.join('.') || '(raíz)'} — ${first.message}` };
  }
  return { contract: parsed.data as ContextContract };
}

function parseContract() { return parseContractText(contractEl.value); }

function renderInputs(contract: ContextContract) {
  const slots = contract.slots.map(s => s.name);
  if (slots.join('|') === renderedSlots.join('|')) return; // unchanged
  renderedSlots = slots;
  clear(inputsEl);
  for (const slot of contract.slots) {
    const wrap = div('input-row');
    const label = document.createElement('label');
    label.textContent = slot.name;
    const meta = document.createElement('span');
    meta.className = 'input-meta';
    meta.textContent = `${slot.source} · p${slot.priority}${slot.immutable ? ' · 🔒' : ''} · ${slot.compaction}`;
    label.appendChild(meta);

    const ta = document.createElement('textarea');
    ta.className = 'code small';
    ta.value = inputState[slot.name] ?? '';
    ta.spellcheck = false;
    ta.addEventListener('input', () => { inputState[slot.name] = ta.value; run(); });

    wrap.appendChild(label);
    wrap.appendChild(ta);
    inputsEl.appendChild(wrap);
  }
}

function statusBadge(status: string): HTMLElement {
  const b = div('badge badge-' + status, status.toUpperCase());
  return b;
}

async function run() {
  saveLocal();
  const { contract, error } = parseContract();
  const statusPill = $('contract-status');

  if (error || !contract) {
    statusPill.textContent = '✕ inválido';
    statusPill.className = 'status-pill bad';
    $('verdict').textContent = '—';
    $('verdict').className = 'status-pill';
    clear($('usage'));
    clear($('findings'));
    $('findings').appendChild(div('finding error', error || 'Contrato inválido'));
    $('payload').textContent = '';
    return;
  }
  statusPill.textContent = '✓ válido';
  statusPill.className = 'status-pill ok';

  renderInputs(contract);

  // Budget slider sync: contract drives the slider unless the user is dragging it.
  const contractBudget = contract.maxTotalTokens;
  if (Number(budgetEl.max) < contractBudget) budgetEl.max = String(contractBudget);
  if (!budgetTouched) budgetEl.value = String(contractBudget);
  const effectiveBudget = Number(budgetEl.value);
  $('budget-val').textContent = String(effectiveBudget);

  const simContract: ContextContract = { ...contract, maxTotalTokens: effectiveBudget };

  const tokenizer = tokenizerEl.value === 'gpt' ? await ensureGptTokenizer() : undefined;
  const engine = new Engine(simContract, {
    tokenizer,
    interpolate: interpolateEl.checked
  });

  const inputs: Record<string, string> = {};
  for (const slot of contract.slots) inputs[slot.name] = inputState[slot.name] ?? '';

  const result = engine.assemble(inputs);
  renderResults(result, effectiveBudget);
}

function renderResults(result: ReturnType<Engine['assemble']>, budget: number) {
  // Verdict
  const v = $('verdict');
  v.textContent = result.verdict.valid ? '✓ VÁLIDO' : '✕ RECHAZADO';
  v.className = 'status-pill ' + (result.verdict.valid ? 'ok' : 'bad');

  // Budget bar
  const total = result.metadata.totalTokens;
  const pct = Math.min(100, budget > 0 ? (total / budget) * 100 : 0);
  const fill = $('budget-fill');
  fill.style.width = pct.toFixed(1) + '%';
  fill.className = 'budget-fill' + (pct > 90 ? ' hot' : pct > 70 ? ' warm' : '');
  $('budget-text').textContent = `${total} / ${budget} tokens (${pct.toFixed(0)}%)`;

  // Usage
  const usage = $('usage');
  clear(usage);
  for (const [name, u] of Object.entries(result.metadata.slotUsage)) {
    const row = div('usage-row');
    row.appendChild(div('usage-name', name));
    row.appendChild(statusBadge(u.status));
    row.appendChild(div('usage-tok', `${u.requestedTokens} → ${u.allocatedTokens} tok`));
    const bar = div('usage-bar');
    const f = div('usage-bar-fill');
    f.style.width = Math.min(100, budget > 0 ? (u.allocatedTokens / budget) * 100 : 0) + '%';
    bar.appendChild(f);
    row.appendChild(bar);
    usage.appendChild(row);
  }

  // Findings
  const findings = $('findings');
  clear(findings);
  if (result.verdict.findings.length === 0) {
    findings.appendChild(div('finding ok', '✓ Sin hallazgos.'));
  } else {
    for (const f of result.verdict.findings) {
      const row = div('finding ' + f.severity);
      row.appendChild(div('badge badge-' + f.severity, f.severity));
      const body = div('finding-body');
      body.appendChild(div('finding-rule', `${f.rule}${f.slot ? ' · ' + f.slot : ''}`));
      body.appendChild(div('finding-msg', f.message));
      row.appendChild(body);
      findings.appendChild(row);
    }
  }

  // Payload — render per-slot so compacted slots are visually flagged.
  lastPayload = result.content;
  const payload = $('payload');
  clear(payload);
  const includedSlots = Object.entries(result.metadata.slotUsage).filter(([, u]) => u.status !== 'omitted');
  if (includedSlots.length === 0) {
    payload.appendChild(div('pl-empty', '(vacío)'));
  } else {
    const re = /=== START SLOT: (.+?) ===\n([\s\S]*?)\n=== END SLOT: \1 ===/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result.content)) !== null) {
      const name = m[1];
      const text = m[2];
      const status = result.metadata.slotUsage[name]?.status ?? 'ok';
      const block = div('pl-slot pl-' + status);
      const head = div('pl-head');
      head.appendChild(div('pl-name', name));
      head.appendChild(div('badge badge-' + status, status));
      block.appendChild(head);
      block.appendChild(div('pl-text', text));
      payload.appendChild(block);
    }
  }
}

// --- Diff view -------------------------------------------------------------
const diffOldEl = $<HTMLTextAreaElement>('diff-old');
const diffNewEl = $<HTMLTextAreaElement>('diff-new');

function changeRow(label: string, from: unknown, to: unknown): HTMLElement {
  const r = div('change-row');
  r.appendChild(div('change-key', label));
  r.appendChild(div('change-from', String(from)));
  r.appendChild(div('change-arrow', '→'));
  r.appendChild(div('change-to', String(to)));
  return r;
}

function renderDiff() {
  const result = $('diff-result');
  const status = $('diff-status');
  clear(result);

  const o = parseContractText(diffOldEl.value);
  const n = parseContractText(diffNewEl.value);
  if (o.error || n.error || !o.contract || !n.contract) {
    status.textContent = '✕ inválido';
    status.className = 'status-pill bad';
    result.appendChild(div('finding error', o.error || n.error || 'Contrato inválido'));
    return;
  }

  const d = diffContracts(o.contract, n.contract);

  // Regressions first — the headline signal.
  if (d.regressions.length) {
    status.textContent = `⚠ ${d.regressions.length} regresión(es)`;
    status.className = 'status-pill bad';
    const sec = div('diff-section');
    sec.appendChild(div('diff-h', '⚠️ Regresiones'));
    for (const r of d.regressions) sec.appendChild(div('finding error', r));
    result.appendChild(sec);
  } else {
    status.textContent = '✓ sin regresiones';
    status.className = 'status-pill ok';
    result.appendChild(div('finding ok', '✓ Sin regresiones detectadas.'));
  }

  const metaKeys = Object.keys(d.metadata);
  if (metaKeys.length) {
    const sec = div('diff-section');
    sec.appendChild(div('diff-h', 'Metadata'));
    for (const k of metaKeys) {
      const c = (d.metadata as Record<string, { from?: unknown; to?: unknown }>)[k];
      sec.appendChild(changeRow(k, c.from, c.to));
    }
    result.appendChild(sec);
  }

  if (d.slots.length) {
    const sec = div('diff-section');
    sec.appendChild(div('diff-h', 'Slots'));
    for (const s of d.slots) {
      const item = div('diff-item');
      item.appendChild(div('diff-tag tag-' + s.type, s.type));
      item.appendChild(div('diff-name', s.name));
      sec.appendChild(item);
      if (s.changes) for (const [k, v] of Object.entries(s.changes)) sec.appendChild(changeRow('· ' + k, v.from, v.to));
    }
    result.appendChild(sec);
  }

  if (d.rules.length) {
    const sec = div('diff-section');
    sec.appendChild(div('diff-h', 'Reglas'));
    for (const r of d.rules) {
      const item = div('diff-item');
      item.appendChild(div('diff-tag tag-' + r.type, r.type));
      item.appendChild(div('diff-name', r.name));
      sec.appendChild(item);
      if (r.changes) for (const [k, v] of Object.entries(r.changes)) sec.appendChild(changeRow('· ' + k, v.from, v.to));
    }
    result.appendChild(sec);
  }
}

// --- Presets ---------------------------------------------------------------
const LONG_DIFF = 'diff --git a/big.js b/big.js\n' +
  '+ const line = "lorem ipsum dolor sit amet consectetur adipiscing";\n'.repeat(40);

const PRESETS: { label: string; state: UIState }[] = [
  {
    label: '✅ PR válido',
    state: { contract: DEFAULT_CONTRACT, inputs: { ...DEFAULT_INPUTS }, tokenizer: 'heuristic', interpolate: false, budget: null }
  },
  {
    label: '🔑 Fuga de secreto',
    state: {
      contract: DEFAULT_CONTRACT,
      inputs: { ...DEFAULT_INPUTS, changed_code: '+ const client_secret = "FAKEDEMO_not_a_real_secret_000000";' },
      tokenizer: 'heuristic', interpolate: false, budget: null
    }
  },
  {
    label: '✂️ Compactación',
    state: {
      contract: DEFAULT_CONTRACT,
      inputs: { ...DEFAULT_INPUTS, changed_code: LONG_DIFF },
      tokenizer: 'heuristic', interpolate: false, budget: 150
    }
  },
  {
    label: '🔗 Interpolación',
    state: {
      contract: DEFAULT_CONTRACT,
      inputs: { ...DEFAULT_INPUTS, user_message: 'Aplica {guidelines} y respeta {system}. (referencia rota: {nope})' },
      tokenizer: 'heuristic', interpolate: true, budget: null
    }
  }
];

const presetsEl = $('presets');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'preset-btn';
  b.textContent = p.label;
  b.addEventListener('click', () => { applyState(structuredClone(p.state)); toast('Preset: ' + p.label); });
  presetsEl.appendChild(b);
}

// --- Wire up ---------------------------------------------------------------
contractEl.addEventListener('input', () => { budgetTouched = false; run(); });
tokenizerEl.addEventListener('change', run);
interpolateEl.addEventListener('change', run);
budgetEl.addEventListener('input', () => { budgetTouched = true; run(); });

$('share').addEventListener('click', async () => {
  location.hash = encodeState(getState());
  try { await navigator.clipboard.writeText(location.href); toast('Enlace copiado al portapapeles'); }
  catch { toast('Enlace generado en la URL'); }
});
$('copy-payload').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(lastPayload); toast('Payload copiado'); }
  catch { toast('No se pudo copiar'); }
});
$('reset').addEventListener('click', () => {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
  history.replaceState(null, '', location.pathname);
  applyState({ contract: DEFAULT_CONTRACT, inputs: { ...DEFAULT_INPUTS }, tokenizer: 'heuristic', interpolate: false, budget: null });
  toast('Restablecido a valores por defecto');
});

// Diff tab: prefill with a v2 that weakens the contract (instant regressions).
const DEFAULT_CONTRACT_V2 = DEFAULT_CONTRACT
  .replace('maxTotalTokens: 600', 'maxTotalTokens: 400')
  .replace('immutable: true', 'immutable: false');
diffOldEl.value = DEFAULT_CONTRACT;
diffNewEl.value = DEFAULT_CONTRACT_V2;
diffOldEl.addEventListener('input', renderDiff);
diffNewEl.addEventListener('input', renderDiff);

// Tabs
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
let diffRendered = false;
for (const t of tabs) {
  t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.toggle('active', x === t));
    const tab = t.dataset.tab;
    $('view-play').hidden = tab !== 'play';
    $('view-diff').hidden = tab !== 'diff';
    if (tab === 'diff' && !diffRendered) { renderDiff(); diffRendered = true; }
  });
}

// Startup load precedence: URL hash > localStorage > default.
const fromHash = location.hash.length > 1 ? decodeState(location.hash.slice(1)) : null;
const initial: UIState = fromHash ?? loadLocal() ?? {
  contract: DEFAULT_CONTRACT, inputs: { ...DEFAULT_INPUTS }, tokenizer: 'heuristic', interpolate: false, budget: null
};
applyState(initial);
