import './style.css';
import yaml from 'js-yaml';
import { Engine, ContextContractSchema } from '../../dist/src/index.js';
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
const inputState: Record<string, string> = { ...DEFAULT_INPUTS };
let renderedSlots: string[] = [];
let budgetTouched = false;

const contractEl = $<HTMLTextAreaElement>('contract');
const tokenizerEl = $<HTMLSelectElement>('tokenizer');
const interpolateEl = $<HTMLInputElement>('interpolate');
const budgetEl = $<HTMLInputElement>('budget');
const inputsEl = $('inputs');

// --- Core ------------------------------------------------------------------
function parseContract(): { contract?: ContextContract; error?: string } {
  let raw: unknown;
  try {
    raw = yaml.load(contractEl.value);
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

  // Payload
  $('payload').textContent = result.content || '(vacío)';
}

// --- Wire up ---------------------------------------------------------------
contractEl.value = DEFAULT_CONTRACT;
contractEl.addEventListener('input', () => { budgetTouched = false; run(); });
tokenizerEl.addEventListener('change', run);
interpolateEl.addEventListener('change', run);
budgetEl.addEventListener('input', () => { budgetTouched = true; run(); });

run();
