import { createHash } from 'crypto';
import {
  ContextContract,
  SlotDefinition,
  DeterministicCheckRule,
  ValidationFinding,
  ValidationVerdict,
  SlotUsageInfo,
  AssemblyMetadata,
  AssembledPayload,
  Tokenizer,
  RuleContext,
  RuleHandler,
  Compactor
} from './types.js';

/**
 * Estimates the token count of a given string using a standard approximation
 * (1 token ≈ 4 characters). This is the deterministic *fallback*; for accurate
 * budgeting against a real model, inject a real Tokenizer into the Engine.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Default tokenizer: the 4-chars-per-token heuristic. Cheap and dependency-free,
 * but only an approximation of any real model tokenizer.
 */
export const heuristicTokenizer: Tokenizer = {
  countTokens: estimateTokens
};

/**
 * Returns the longest prefix of `text` whose token count is <= maxTokens, for ANY
 * tokenizer. Uses the tokenizer's native truncation if provided, otherwise a
 * surrogate-safe binary search over the character length. This is what makes the
 * budget invariant hold regardless of the tokenizer in use.
 */
export function truncateToTokens(text: string, maxTokens: number, tokenizer: Tokenizer): string {
  if (maxTokens <= 0) return '';
  if (tokenizer.countTokens(text) <= maxTokens) return text;
  if (tokenizer.truncateToTokens) return tokenizer.truncateToTokens(text, maxTokens);

  let lo = 0;
  let hi = text.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokenizer.countTokens(text.slice(0, mid)) <= maxTokens) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Never end on a lone high surrogate (would emit a broken half of a code point).
  if (best > 0 && best < text.length) {
    const code = text.charCodeAt(best - 1);
    if (code >= 0xd800 && code <= 0xdbff) best -= 1;
  }
  return text.slice(0, best);
}

/**
 * Helper to compute SHA-256 hash of a string.
 */
export function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Built-in rule handlers. Each is a pure function (RuleContext) => findings.
// They are dispatched by `rule.type`; custom handlers can be registered on the
// Engine to extend or override these.
// ---------------------------------------------------------------------------

/**
 * Heuristic detection of regex patterns prone to catastrophic backtracking (ReDoS).
 * Targets the dominant cause: an unbounded quantifier applied to a group whose body
 * itself contains an unbounded quantifier (star height >= 2), e.g. `(a+)+`, `(.*)*`,
 * `([a-z]+)*`. This is a HEURISTIC: it catches the common cases but does not prove
 * safety for every pattern (e.g. alternation-overlap ReDoS is not detected).
 */
export function isReDoSVulnerable(pattern: string): boolean {
  const p = pattern.replace(/\\./g, ''); // drop escaped chars so `\(` `\+` don't confuse the scan
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== ')') continue;
    const next = p[i + 1];
    const quantified =
      next === '*' || next === '+' || (next === '{' && /^\{\d*,\}/.test(p.slice(i + 1)));
    if (!quantified) continue;
    // Find the matching '(' for this ')'.
    let depth = 1;
    let j = i - 1;
    for (; j >= 0; j--) {
      if (p[j] === ')') depth++;
      else if (p[j] === '(') { depth--; if (depth === 0) break; }
    }
    if (j < 0) continue;
    const body = p.slice(j + 1, i);
    // Body has its own unbounded/range quantifier? => nested quantifier => risky.
    if (/[*+]/.test(body) || /\{\d*,\d*\}/.test(body)) return true;
  }
  return false;
}

/**
 * Builds the built-in `regex` rule handler with ReDoS protection.
 * - `rejectUnsafe` (default true): statically-detected catastrophic patterns are
 *   refused (finding `unsafe-regex-pattern`) and never executed.
 * - `maxInputLength` (default 1,000,000): the regex is evaluated on at most this
 *   many characters, bounding worst-case runtime for patterns the heuristic misses.
 */
export function createRegexRuleHandler(
  opts: { rejectUnsafe?: boolean; maxInputLength?: number } = {}
): RuleHandler {
  const rejectUnsafe = opts.rejectUnsafe ?? true;
  const maxInputLength = opts.maxInputLength ?? 1_000_000;

  return ({ rule, text }) => {
    if (!rule.pattern) {
      return [{
        severity: 'warning',
        rule: 'invalid-rule-config',
        message: `Regex rule "${rule.name}" misses pattern configuration.`,
        slot: rule.targetSlot
      }];
    }
    if (rejectUnsafe && isReDoSVulnerable(rule.pattern)) {
      return [{
        severity: 'error',
        rule: 'unsafe-regex-pattern',
        message: `Regex pattern in rule "${rule.name}" looks vulnerable to catastrophic backtracking (nested quantifiers) and was not executed. Simplify the pattern, or register a custom regex handler if you trust it.`,
        slot: rule.targetSlot
      }];
    }

    const findings: ValidationFinding[] = [];
    let target = text;
    if (target.length > maxInputLength) {
      target = target.slice(0, maxInputLength);
      findings.push({
        severity: 'info',
        rule: 'regex-input-bounded',
        message: `Slot "${rule.targetSlot}" exceeded ${maxInputLength} chars; the regex was evaluated on a prefix to bound runtime.`,
        slot: rule.targetSlot
      });
    }

    try {
      // Strip the global flag: a stateful `lastIndex` would make repeated
      // .test() calls non-deterministic, defeating the purpose of the check.
      const safeFlags = (rule.flags || '').replace(/g/g, '');
      const regex = new RegExp(rule.pattern, safeFlags);
      const matches = regex.test(target);
      const shouldTrigger = rule.negate ? matches : !matches;
      if (shouldTrigger) {
        findings.push({
          severity: rule.severity,
          rule: rule.name,
          message: rule.message || `Regex verification failed for slot "${rule.targetSlot}" using pattern: ${rule.pattern}`,
          slot: rule.targetSlot
        });
      }
      return findings;
    } catch (e: any) {
      findings.push({
        severity: 'error',
        rule: 'invalid-regex-syntax',
        message: `Invalid regex pattern "${rule.pattern}" in rule "${rule.name}": ${e.message}`,
        slot: rule.targetSlot
      });
      return findings;
    }
  };
}

const regexRuleHandler: RuleHandler = createRegexRuleHandler();

const schemaRuleHandler: RuleHandler = ({ rule, text }) => {
  if (!text.trim()) return [];
  const findings: ValidationFinding[] = [];
  try {
    const parsed = JSON.parse(text);
    if (rule.schemaJson) {
      const schema = JSON.parse(rule.schemaJson);
      if (schema.required && Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          if (!(reqKey in parsed)) {
            findings.push({
              severity: rule.severity,
              rule: rule.name,
              message: `JSON content in slot "${rule.targetSlot}" misses required schema key: "${reqKey}"`,
              slot: rule.targetSlot
            });
          }
        }
      }
    }
  } catch (e: any) {
    findings.push({
      severity: 'error',
      rule: `${rule.name}-invalid-json`,
      message: `JSON syntax error in slot "${rule.targetSlot}": ${e.message}`,
      slot: rule.targetSlot
    });
  }
  return findings;
};

const immutableHashRuleHandler: RuleHandler = ({ rule, text, expectedHashes, computeHash: hash }) => {
  if (!text.trim()) return [];
  const currentHash = hash(text);
  const expectedHash = expectedHashes?.[rule.targetSlot];
  if (expectedHash && currentHash !== expectedHash) {
    return [{
      severity: rule.severity,
      rule: rule.name,
      message: `Immutable verification failed for slot "${rule.targetSlot}". Content hash has drifted from expected signature.`,
      slot: rule.targetSlot
    }];
  }
  return [];
};

const brokenRefRuleHandler: RuleHandler = ({ rule, text, contract }) => {
  const findings: ValidationFinding[] = [];
  const refRegex = /\{([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)?\}/g;
  const slotNames = contract.slots.map(s => s.name);
  let match;
  while ((match = refRegex.exec(text)) !== null) {
    const referencedSlot = match[1];
    if (!slotNames.includes(referencedSlot)) {
      findings.push({
        severity: rule.severity,
        rule: rule.name,
        message: `Broken reference: Reference "{${referencedSlot}}" found in slot "${rule.targetSlot}" refers to a slot that does not exist in the contract.`,
        slot: rule.targetSlot
      });
    }
  }
  return findings;
};

/** The rule handlers shipped with the engine, keyed by rule type. */
export const builtinRuleHandlers: Record<string, RuleHandler> = {
  'regex': regexRuleHandler,
  'schema': schemaRuleHandler,
  'immutable-hash': immutableHashRuleHandler,
  'broken-ref': brokenRefRuleHandler
};

// ---------------------------------------------------------------------------
// Built-in compaction strategies. Each fits an oversized slot to its budget.
// The engine clamps any compactor's output to maxTokens, so the budget invariant
// holds even for custom (e.g. LLM-based) compactors that might overshoot.
// ---------------------------------------------------------------------------

const truncateCompactor: Compactor = (text, { slot, maxTokens, tokenizer, requestedTokens }) => {
  const out = truncateToTokens(text, maxTokens, tokenizer);
  return {
    text: out,
    status: 'truncated',
    findings: [{
      severity: 'warning',
      rule: 'budget-truncated',
      message: `Slot "${slot.name}" truncated to fit allocated budget of ${maxTokens} tokens (originally ${requestedTokens} tokens).`,
      slot: slot.name
    }]
  };
};

const summarizeCompactor: Compactor = (text, { slot, maxTokens, tokenizer }) => {
  const marker = '\n\n[... Content truncated & summarized ...]';
  const markerTokens = tokenizer.countTokens(marker);
  const bodyBudget = Math.max(0, maxTokens - markerTokens);
  const body = truncateToTokens(text, bodyBudget, tokenizer);
  let out = body + marker;
  if (tokenizer.countTokens(out) > maxTokens) {
    out = truncateToTokens(out, maxTokens, tokenizer);
  }
  return {
    text: out,
    status: 'summarized',
    findings: [{
      severity: 'warning',
      rule: 'budget-summarized',
      message: `Slot "${slot.name}" compacted (summarized) to fit budget of ${maxTokens} tokens.`,
      slot: slot.name
    }]
  };
};

/** The compaction strategies shipped with the engine, keyed by name. */
export const builtinCompactors: Record<string, Compactor> = {
  'truncate': truncateCompactor,
  'summarize': summarizeCompactor
};

export class Engine {
  private contract: ContextContract;
  private tokenizer: Tokenizer;
  private ruleHandlers: Record<string, RuleHandler>;
  private compactors: Record<string, Compactor>;
  private interpolate: boolean;

  constructor(
    contract: ContextContract,
    options: {
      tokenizer?: Tokenizer;
      ruleHandlers?: Record<string, RuleHandler>;
      compactors?: Record<string, Compactor>;
      interpolate?: boolean;
    } = {}
  ) {
    this.contract = contract;
    this.tokenizer = options.tokenizer ?? heuristicTokenizer;
    // Custom handlers/compactors override/extend the built-ins by name.
    this.ruleHandlers = { ...builtinRuleHandlers, ...(options.ruleHandlers || {}) };
    this.compactors = { ...builtinCompactors, ...(options.compactors || {}) };
    this.interpolate = options.interpolate ?? false;
  }

  /**
   * Resolves `{slot}` and `{slot.key}` references in a text against the given inputs.
   * - `{slot}` -> the slot's raw input text.
   * - `{slot.key}` -> the value at `key` if the slot's input is a JSON object.
   * References to unknown slots (or unresolved keys) are left verbatim, so the
   * `broken-ref` rule can still flag genuinely broken references.
   */
  private resolveRefs(text: string, inputs: Record<string, string>): string {
    return text.replace(/\{([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_-]+))?\}/g, (whole, slot, key) => {
      if (!(slot in inputs)) return whole;
      const raw = inputs[slot];
      if (key === undefined) return raw;
      try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && key in obj) {
          const v = (obj as Record<string, unknown>)[key];
          return typeof v === 'string' ? v : JSON.stringify(v);
        }
      } catch {
        /* not JSON — fall through */
      }
      return whole;
    });
  }

  /**
   * Single-pass interpolation: every reference resolves against the ORIGINAL
   * inputs (not against already-interpolated values), which makes it inherently
   * cycle-safe and deterministic.
   */
  private interpolateInputs(inputs: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, text] of Object.entries(inputs)) {
      out[name] = this.resolveRefs(text, inputs);
    }
    return out;
  }

  /**
   * Allocates budgets to each slot based on priority and total budget restrictions.
   */
  public allocateBudgets(inputs: Record<string, string>): {
    allocatedTexts: Record<string, string>;
    usage: Record<string, SlotUsageInfo>;
    findings: ValidationFinding[];
  } {
    const usage: Record<string, SlotUsageInfo> = {};
    const allocatedTexts: Record<string, string> = {};
    const findings: ValidationFinding[] = [];

    // Resolve {slot} references before budgeting, so compaction and the budget
    // invariant apply to the final (interpolated) content. Opt-in; no-op by default.
    const src = this.interpolate ? this.interpolateInputs(inputs) : inputs;

    // Sort slots by priority: lowest priority number = highest importance (allocated first)
    const sortedSlots = [...this.contract.slots].sort((a, b) => a.priority - b.priority);

    let remainingTotalTokens = this.contract.maxTotalTokens;

    for (const slot of sortedSlots) {
      const rawText = src[slot.name] || '';
      const requestedTokens = this.tokenizer.countTokens(rawText);

      // Default state
      let allocatedTokens = 0;
      let status: SlotUsageInfo['status'] = 'ok';
      let finalText = '';

      if (slot.required && !src[slot.name]) {
        findings.push({
          severity: 'error',
          rule: 'required-slot-missing',
          message: `Required slot "${slot.name}" is missing from inputs.`,
          slot: slot.name
        });
        usage[slot.name] = { requestedTokens: 0, allocatedTokens: 0, status: 'omitted' };
        continue;
      }

      if (!src[slot.name]) {
        usage[slot.name] = { requestedTokens: 0, allocatedTokens: 0, status: 'omitted' };
        continue;
      }

      // Check maxTokens constraint for this specific slot
      let slotLimit = slot.maxTokens ? Math.min(slot.maxTokens, remainingTotalTokens) : remainingTotalTokens;

      if (requestedTokens <= slotLimit) {
        allocatedTokens = requestedTokens;
        finalText = rawText;
        status = 'ok';
      } else if (slot.compaction === 'error') {
        // 'error' is a policy, not a transformation: fail instead of compacting.
        findings.push({
          severity: 'error',
          rule: 'budget-overflow-error',
          message: `Slot "${slot.name}" requires ${requestedTokens} tokens, which exceeds the limit of ${slotLimit} tokens. Compaction strategy is set to "error".`,
          slot: slot.name
        });
        allocatedTokens = 0;
        finalText = '';
        status = 'omitted';
      } else {
        // Dispatch to the registered compactor (built-in or custom).
        const compactor = this.compactors[slot.compaction];
        if (!compactor) {
          findings.push({
            severity: 'error',
            rule: 'unknown-compaction-strategy',
            message: `No compactor registered for strategy "${slot.compaction}" on slot "${slot.name}".`,
            slot: slot.name
          });
          allocatedTokens = 0;
          finalText = '';
          status = 'omitted';
        } else {
          const result = compactor(rawText, {
            slot,
            maxTokens: slotLimit,
            tokenizer: this.tokenizer,
            requestedTokens,
            truncateToTokens
          });
          // Enforce the budget invariant regardless of what the compactor returned.
          finalText = this.tokenizer.countTokens(result.text) > slotLimit
            ? truncateToTokens(result.text, slotLimit, this.tokenizer)
            : result.text;
          allocatedTokens = this.tokenizer.countTokens(finalText);
          status = result.status ?? 'summarized';
          if (result.findings) findings.push(...result.findings);
        }
      }

      remainingTotalTokens -= allocatedTokens;
      allocatedTexts[slot.name] = finalText;
      usage[slot.name] = {
        requestedTokens,
        allocatedTokens,
        status
      };
    }

    return { allocatedTexts, usage, findings };
  }

  /**
   * Runs the deterministic linter rules on the allocated text contents.
   */
  public lint(
    allocatedTexts: Record<string, string>,
    usage: Record<string, SlotUsageInfo>,
    expectedHashes?: Record<string, string>
  ): ValidationVerdict {
    const findings: ValidationFinding[] = [];

    // Dispatch each contract rule to its registered handler (built-in or custom).
    for (const rule of this.contract.rules) {
      const handler = this.ruleHandlers[rule.type];
      if (!handler) {
        findings.push({
          severity: 'warning',
          rule: 'unknown-rule-type',
          message: `No handler registered for rule type "${rule.type}" (rule "${rule.name}"). Rule skipped.`,
          slot: rule.targetSlot
        });
        continue;
      }
      const ctx: RuleContext = {
        rule,
        text: allocatedTexts[rule.targetSlot] || '',
        allocatedTexts,
        contract: this.contract,
        expectedHashes,
        computeHash
      };
      findings.push(...handler(ctx));
    }

    // 3. Immutability checks: if a slot is marked immutable, verify that it isn't tampered with
    for (const slot of this.contract.slots) {
      if (slot.immutable) {
        const text = allocatedTexts[slot.name] || '';
        const expectedHash = expectedHashes?.[slot.name];
        if (expectedHash && text) {
          const currentHash = computeHash(text);
          if (currentHash !== expectedHash) {
            findings.push({
              severity: 'error',
              rule: 'immutable-slot-drift',
              message: `Immutable slot "${slot.name}" has drifted. Hash changes are prohibited for static immutable slots.`,
              slot: slot.name
            });
          }
        }
      }
    }

    const hasErrors = findings.some(f => f.severity === 'error');

    return {
      valid: !hasErrors,
      findings
    };
  }

  /**
   * Mixes inputs and constructs the final assembled payload, running the linter validation.
   */
  public assemble(inputs: Record<string, string>, expectedHashes?: Record<string, string>): AssembledPayload {
    // 1. Allocate budgets
    const { allocatedTexts, usage, findings: allocFindings } = this.allocateBudgets(inputs);

    // 2. Run linter
    const linterResult = this.lint(allocatedTexts, usage, expectedHashes);

    // Aggregate findings
    const allFindings = [...allocFindings, ...linterResult.findings];
    const hasErrors = allFindings.some(f => f.severity === 'error');
    const finalVerdict: ValidationVerdict = {
      valid: !hasErrors,
      findings: allFindings
    };

    // 3. Assemble sections in original order defined in the contract
    const orderedSections: string[] = [];
    let totalTokens = 0;

    for (const slot of this.contract.slots) {
      const text = allocatedTexts[slot.name];
      if (text !== undefined && text !== '') {
        orderedSections.push(`=== START SLOT: ${slot.name} ===\n${text}\n=== END SLOT: ${slot.name} ===`);
        totalTokens += usage[slot.name]?.allocatedTokens || 0;
      }
    }

    const finalContent = orderedSections.join('\n\n');

    const metadata: AssemblyMetadata = {
      slotUsage: usage,
      totalTokens,
      timestamp: new Date().toISOString(),
      contractVersion: this.contract.version
    };

    return {
      content: finalContent,
      metadata,
      verdict: finalVerdict
    };
  }
}
