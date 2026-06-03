import { z } from 'zod';

export const SlotSourceSchema = z.enum(['static', 'dynamic', 'state', 'environment']);
export type SlotSource = z.infer<typeof SlotSourceSchema>;

export const BUILTIN_COMPACTION_STRATEGIES = ['truncate', 'summarize', 'error'] as const;
export const SlotCompactionSchema = z.enum(BUILTIN_COMPACTION_STRATEGIES);
export type SlotCompaction = z.infer<typeof SlotCompactionSchema>;

export const SlotFormatSchema = z.enum(['text', 'json', 'markdown']);
export type SlotFormat = z.infer<typeof SlotFormatSchema>;

export const SlotDefinitionSchema = z.object({
  name: z.string(),
  source: SlotSourceSchema,
  priority: z.number().int().nonnegative(), // 0 = highest priority, allocated first
  maxTokens: z.number().int().positive().optional(),
  immutable: z.boolean().optional().default(false),
  // 'error', a built-in ('truncate'/'summarize'), or a custom strategy registered on the Engine.
  compaction: z.string().optional().default('error'),
  format: SlotFormatSchema.optional().default('text'),
  required: z.boolean().optional().default(true),
  description: z.string().optional()
});
export type SlotDefinition = z.infer<typeof SlotDefinitionSchema>;

export const BUILTIN_RULE_TYPES = [
  'regex',            // Check content matches (or does not match) a pattern
  'broken-ref',       // Check that cross-slot references resolve
  'immutable-hash',   // Check that static immutable content hasn't drifted
  'schema'            // Check JSON schema if slot format is json
] as const;
export const CheckRuleTypeSchema = z.enum(BUILTIN_RULE_TYPES);
export type CheckRuleType = z.infer<typeof CheckRuleTypeSchema>;

export const DeterministicCheckRuleSchema = z.object({
  name: z.string(),
  // A built-in type (see BUILTIN_RULE_TYPES) or any custom type registered on the Engine.
  type: z.string(),
  targetSlot: z.string(),
  pattern: z.string().optional(),     // Regex pattern for 'regex' checks
  flags: z.string().optional(),       // Optional regex flags (e.g. 'i', 'm', 'gm') for 'regex' checks
  negate: z.boolean().optional(),     // If true, match is an error/warning
  schemaJson: z.string().optional(),  // JSON schema as string for 'schema' checks
  message: z.string().optional(),
  severity: z.enum(['error', 'warning', 'info']).optional().default('error')
});
export type DeterministicCheckRule = z.infer<typeof DeterministicCheckRuleSchema>;

export const ContextContractSchema = z.object({
  version: z.string(),
  name: z.string(),
  maxTotalTokens: z.number().int().positive(),
  slots: z.array(SlotDefinitionSchema),
  rules: z.array(DeterministicCheckRuleSchema).default([])
});
export type ContextContract = z.infer<typeof ContextContractSchema>;

/**
 * Pluggable token counter. The engine depends only on this interface, never on a
 * specific tokenizer, so contracts can be budgeted against a real model tokenizer.
 */
export interface Tokenizer {
  /** Number of tokens the given text occupies. */
  countTokens(text: string): number;
  /**
   * Optional tokenizer-native truncation: the longest prefix of `text` whose token
   * count is <= maxTokens. If omitted, the engine derives it via binary search on
   * `countTokens`, which works for any tokenizer.
   */
  truncateToTokens?(text: string, maxTokens: number): string;
}

/**
 * Context passed to a compactor when a slot exceeds its token budget.
 */
export interface CompactionContext {
  /** The slot being compacted. */
  slot: SlotDefinition;
  /** Token budget the result must fit within. */
  maxTokens: number;
  /** The active tokenizer (use it so the result respects the budget). */
  tokenizer: Tokenizer;
  /** Token count of the original (pre-compaction) text. */
  requestedTokens: number;
  /** Budget-safe truncation helper for any tokenizer. */
  truncateToTokens: (text: string, maxTokens: number, tokenizer: Tokenizer) => string;
}

export interface CompactionResult {
  /** The compacted text. The engine clamps it to maxTokens if a compactor overshoots. */
  text: string;
  /** Status reported in slot usage. Defaults to 'summarized' for custom compactors. */
  status?: 'truncated' | 'summarized';
  /** Findings to surface (e.g. a warning that content was dropped). */
  findings?: ValidationFinding[];
}

/**
 * A compaction strategy: produces a fitted version of an oversized slot.
 * Register custom strategies via `new Engine(contract, { compactors })`.
 */
export type Compactor = (text: string, ctx: CompactionContext) => CompactionResult;

export interface ValidationFinding {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  slot?: string;
}

export interface ValidationVerdict {
  valid: boolean;
  findings: ValidationFinding[];
}

/**
 * Context passed to a rule handler when the linter evaluates one rule.
 */
export interface RuleContext {
  /** The rule being evaluated. */
  rule: DeterministicCheckRule;
  /** Allocated (post-compaction) text of the rule's targetSlot, or '' if absent. */
  text: string;
  /** All allocated slot texts, for rules that need cross-slot access. */
  allocatedTexts: Record<string, string>;
  /** The full contract (e.g. to resolve declared slot names). */
  contract: ContextContract;
  /** Expected SHA-256 hashes by slot, if provided to the engine. */
  expectedHashes?: Record<string, string>;
  /** SHA-256 helper, so handlers don't import crypto directly. */
  computeHash: (text: string) => string;
}

/**
 * A deterministic rule handler: pure function from a RuleContext to findings.
 * Register custom handlers via `new Engine(contract, { ruleHandlers })`.
 */
export type RuleHandler = (ctx: RuleContext) => ValidationFinding[];

export interface SlotUsageInfo {
  requestedTokens: number;
  allocatedTokens: number;
  status: 'ok' | 'truncated' | 'summarized' | 'omitted';
}

export interface AssemblyMetadata {
  slotUsage: Record<string, SlotUsageInfo>;
  totalTokens: number;
  timestamp: string;
  contractVersion: string;
}

export interface AssembledPayload {
  content: string;
  metadata: AssemblyMetadata;
  verdict: ValidationVerdict;
}
