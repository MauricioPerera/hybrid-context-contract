import { createHash } from 'crypto';
import {
  ContextContract,
  SlotDefinition,
  DeterministicCheckRule,
  ValidationFinding,
  ValidationVerdict,
  SlotUsageInfo,
  AssemblyMetadata,
  AssembledPayload
} from './types.js';

/**
 * Estimates the token count of a given string using a standard approximation
 * (1 token ≈ 4 characters).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Helper to compute SHA-256 hash of a string.
 */
export function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class Engine {
  private contract: ContextContract;

  constructor(contract: ContextContract) {
    this.contract = contract;
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

    // Sort slots by priority: lowest priority number = highest importance (allocated first)
    const sortedSlots = [...this.contract.slots].sort((a, b) => a.priority - b.priority);

    let remainingTotalTokens = this.contract.maxTotalTokens;

    for (const slot of sortedSlots) {
      const rawText = inputs[slot.name] || '';
      const requestedTokens = estimateTokens(rawText);
      
      // Default state
      let allocatedTokens = 0;
      let status: SlotUsageInfo['status'] = 'ok';
      let finalText = '';

      if (slot.required && !inputs[slot.name]) {
        findings.push({
          severity: 'error',
          rule: 'required-slot-missing',
          message: `Required slot "${slot.name}" is missing from inputs.`,
          slot: slot.name
        });
        usage[slot.name] = { requestedTokens: 0, allocatedTokens: 0, status: 'omitted' };
        continue;
      }

      if (!inputs[slot.name]) {
        usage[slot.name] = { requestedTokens: 0, allocatedTokens: 0, status: 'omitted' };
        continue;
      }

      // Check maxTokens constraint for this specific slot
      let slotLimit = slot.maxTokens ? Math.min(slot.maxTokens, remainingTotalTokens) : remainingTotalTokens;

      if (requestedTokens <= slotLimit) {
        allocatedTokens = requestedTokens;
        finalText = rawText;
        status = 'ok';
      } else {
        // We need compaction
        if (slot.compaction === 'error') {
          findings.push({
            severity: 'error',
            rule: 'budget-overflow-error',
            message: `Slot "${slot.name}" requires ${requestedTokens} tokens, which exceeds the limit of ${slotLimit} tokens. Compaction strategy is set to "error".`,
            slot: slot.name
          });
          allocatedTokens = 0;
          finalText = '';
          status = 'omitted';
        } else if (slot.compaction === 'truncate') {
          allocatedTokens = slotLimit;
          // Approximate truncation by character limit (4 characters per token)
          const charLimit = slotLimit * 4;
          finalText = rawText.substring(0, charLimit);
          status = 'truncated';
          findings.push({
            severity: 'warning',
            rule: 'budget-truncated',
            message: `Slot "${slot.name}" truncated to fit allocated budget of ${slotLimit} tokens (originally ${requestedTokens} tokens).`,
            slot: slot.name
          });
        } else if (slot.compaction === 'summarize') {
          // Reserve room for the marker so the final text (content + marker)
          // never exceeds the slot's character budget.
          const marker = '\n\n[... Content truncated & summarized ...]';
          const charBudget = slotLimit * 4;
          const charLimit = Math.max(0, charBudget - marker.length);
          finalText = (rawText.substring(0, charLimit) + marker).substring(0, charBudget);
          // Report the actual token cost of the compacted text, not the ceiling.
          allocatedTokens = estimateTokens(finalText);
          status = 'summarized';
          findings.push({
            severity: 'warning',
            rule: 'budget-summarized',
            message: `Slot "${slot.name}" compacted (summarized) to fit budget of ${slotLimit} tokens.`,
            slot: slot.name
          });
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

    // 1. Structural checks from allocation
    // We already generated some allocation findings; we will aggregate them.

    // 2. Process custom rules in contract
    for (const rule of this.contract.rules) {
      const text = allocatedTexts[rule.targetSlot] || '';

      if (rule.type === 'regex') {
        if (!rule.pattern) {
          findings.push({
            severity: 'warning',
            rule: 'invalid-rule-config',
            message: `Regex rule "${rule.name}" misses pattern configuration.`,
            slot: rule.targetSlot
          });
          continue;
        }

        try {
          // Strip the global flag: a stateful `lastIndex` would make repeated
          // .test() calls non-deterministic, defeating the purpose of the check.
          const safeFlags = (rule.flags || '').replace(/g/g, '');
          const regex = new RegExp(rule.pattern, safeFlags);
          const matches = regex.test(text);

          const shouldTrigger = rule.negate ? matches : !matches;
          if (shouldTrigger) {
            findings.push({
              severity: rule.severity,
              rule: rule.name,
              message: rule.message || `Regex verification failed for slot "${rule.targetSlot}" using pattern: ${rule.pattern}`,
              slot: rule.targetSlot
            });
          }
        } catch (e: any) {
          findings.push({
            severity: 'error',
            rule: 'invalid-regex-syntax',
            message: `Invalid regex pattern "${rule.pattern}" in rule "${rule.name}": ${e.message}`,
            slot: rule.targetSlot
          });
        }
      }

      if (rule.type === 'schema') {
        if (!text.trim()) continue;
        try {
          const parsed = JSON.parse(text);
          if (rule.schemaJson) {
            // Simple key/type validation for JSON schema validation demonstration
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
      }

      if (rule.type === 'immutable-hash') {
        if (!text.trim()) continue;
        const currentHash = computeHash(text);
        const expectedHash = expectedHashes?.[rule.targetSlot];
        if (expectedHash && currentHash !== expectedHash) {
          findings.push({
            severity: rule.severity,
            rule: rule.name,
            message: `Immutable verification failed for slot "${rule.targetSlot}". Content hash has drifted from expected signature.`,
            slot: rule.targetSlot
          });
        }
      }

      if (rule.type === 'broken-ref') {
        // Matches cross-slot reference patterns like {slotName} or {slotName.key}
        const refRegex = /\{([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)?\}/g;
        let match;
        const slotNames = this.contract.slots.map(s => s.name);

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
      }
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
