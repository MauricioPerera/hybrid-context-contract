import { z } from 'zod';

export const SlotSourceSchema = z.enum(['static', 'dynamic', 'state', 'environment']);
export type SlotSource = z.infer<typeof SlotSourceSchema>;

export const SlotCompactionSchema = z.enum(['truncate', 'summarize', 'error']);
export type SlotCompaction = z.infer<typeof SlotCompactionSchema>;

export const SlotFormatSchema = z.enum(['text', 'json', 'markdown']);
export type SlotFormat = z.infer<typeof SlotFormatSchema>;

export const SlotDefinitionSchema = z.object({
  name: z.string(),
  source: SlotSourceSchema,
  priority: z.number().int().nonnegative(), // 0 = highest priority, allocated first
  maxTokens: z.number().int().positive().optional(),
  immutable: z.boolean().optional().default(false),
  compaction: SlotCompactionSchema.optional().default('error'),
  format: SlotFormatSchema.optional().default('text'),
  required: z.boolean().optional().default(true),
  description: z.string().optional()
});
export type SlotDefinition = z.infer<typeof SlotDefinitionSchema>;

export const CheckRuleTypeSchema = z.enum([
  'regex',            // Check content matches (or does not match) a pattern
  'broken-ref',       // Check that cross-slot references resolve
  'immutable-hash',   // Check that static immutable content hasn't drifted
  'schema'            // Check JSON schema if slot format is json
]);
export type CheckRuleType = z.infer<typeof CheckRuleTypeSchema>;

export const DeterministicCheckRuleSchema = z.object({
  name: z.string(),
  type: CheckRuleTypeSchema,
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
