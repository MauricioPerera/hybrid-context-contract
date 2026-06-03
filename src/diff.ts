import { ContextContract, SlotDefinition, DeterministicCheckRule } from './types.js';

export interface DiffChange<T> {
  from?: T;
  to?: T;
}

export interface SlotDiff {
  type: 'added' | 'removed' | 'modified';
  name: string;
  changes?: {
    source?: DiffChange<string>;
    priority?: DiffChange<number>;
    maxTokens?: DiffChange<number | undefined>;
    immutable?: DiffChange<boolean>;
    compaction?: DiffChange<string>;
    format?: DiffChange<string>;
    required?: DiffChange<boolean>;
  };
}

export interface RuleDiff {
  type: 'added' | 'removed' | 'modified';
  name: string;
  changes?: {
    type?: DiffChange<string>;
    targetSlot?: DiffChange<string>;
    severity?: DiffChange<string>;
  };
}

export interface ContractDiffResult {
  metadata: {
    version?: DiffChange<string>;
    name?: DiffChange<string>;
    maxTotalTokens?: DiffChange<number>;
  };
  slots: SlotDiff[];
  rules: RuleDiff[];
  regressions: string[];
}

export function diffContracts(oldContract: ContextContract, newContract: ContextContract): ContractDiffResult {
  const result: ContractDiffResult = {
    metadata: {},
    slots: [],
    rules: [],
    regressions: []
  };

  // 1. Metadata diff
  if (oldContract.version !== newContract.version) {
    result.metadata.version = { from: oldContract.version, to: newContract.version };
  }
  if (oldContract.name !== newContract.name) {
    result.metadata.name = { from: oldContract.name, to: newContract.name };
  }
  if (oldContract.maxTotalTokens !== newContract.maxTotalTokens) {
    result.metadata.maxTotalTokens = { from: oldContract.maxTotalTokens, to: newContract.maxTotalTokens };
    // Regression check: total token capacity reduced
    if (newContract.maxTotalTokens < oldContract.maxTotalTokens) {
      result.regressions.push(
        `Total token window budget decreased from ${oldContract.maxTotalTokens} to ${newContract.maxTotalTokens}. This might cause unexpected truncation.`
      );
    }
  }

  // 2. Slots diff
  const oldSlotsMap = new Map(oldContract.slots.map(s => [s.name, s]));
  const newSlotsMap = new Map(newContract.slots.map(s => [s.name, s]));

  // Added & Modified slots
  for (const [name, newSlot] of newSlotsMap.entries()) {
    const oldSlot = oldSlotsMap.get(name);
    if (!oldSlot) {
      result.slots.push({
        type: 'added',
        name
      });
    } else {
      const changes: SlotDiff['changes'] = {};
      let modified = false;

      if (oldSlot.source !== newSlot.source) {
        changes.source = { from: oldSlot.source, to: newSlot.source };
        modified = true;
      }
      if (oldSlot.priority !== newSlot.priority) {
        changes.priority = { from: oldSlot.priority, to: newSlot.priority };
        modified = true;

        // Regression: check if priority was lowered (priority value increased)
        if (newSlot.priority > oldSlot.priority) {
          result.regressions.push(
            `Priority of slot "${name}" was lowered (priority value changed from ${oldSlot.priority} to ${newSlot.priority}). It will be budgeted later and is more prone to truncation.`
          );
        }
      }
      if (oldSlot.maxTokens !== newSlot.maxTokens) {
        changes.maxTokens = { from: oldSlot.maxTokens, to: newSlot.maxTokens };
        modified = true;
      }
      if (oldSlot.immutable !== newSlot.immutable) {
        changes.immutable = { from: oldSlot.immutable, to: newSlot.immutable };
        modified = true;
      }
      if (oldSlot.compaction !== newSlot.compaction) {
        changes.compaction = { from: oldSlot.compaction, to: newSlot.compaction };
        modified = true;
      }
      if (oldSlot.format !== newSlot.format) {
        changes.format = { from: oldSlot.format, to: newSlot.format };
        modified = true;
      }
      if (oldSlot.required !== newSlot.required) {
        changes.required = { from: oldSlot.required, to: newSlot.required };
        modified = true;
      }

      if (modified) {
        result.slots.push({
          type: 'modified',
          name,
          changes
        });
      }
    }
  }

  // Removed slots
  for (const name of oldSlotsMap.keys()) {
    if (!newSlotsMap.has(name)) {
      result.slots.push({
        type: 'removed',
        name
      });
      // Regression: check if a required slot was removed
      const oldSlot = oldSlotsMap.get(name);
      if (oldSlot?.required) {
        result.regressions.push(`Required slot "${name}" was removed from the contract.`);
      }
    }
  }

  // 3. Rules diff
  const oldRulesMap = new Map(oldContract.rules.map(r => [r.name, r]));
  const newRulesMap = new Map(newContract.rules.map(r => [r.name, r]));

  for (const [name, newRule] of newRulesMap.entries()) {
    const oldRule = oldRulesMap.get(name);
    if (!oldRule) {
      result.rules.push({
        type: 'added',
        name
      });
    } else {
      const changes: RuleDiff['changes'] = {};
      let modified = false;

      if (oldRule.type !== newRule.type) {
        changes.type = { from: oldRule.type, to: newRule.type };
        modified = true;
      }
      if (oldRule.targetSlot !== newRule.targetSlot) {
        changes.targetSlot = { from: oldRule.targetSlot, to: newRule.targetSlot };
        modified = true;
      }
      if (oldRule.severity !== newRule.severity) {
        changes.severity = { from: oldRule.severity, to: newRule.severity };
        modified = true;
      }

      if (modified) {
        result.rules.push({
          type: 'modified',
          name,
          changes
        });
      }
    }
  }

  for (const name of oldRulesMap.keys()) {
    if (!newRulesMap.has(name)) {
      result.rules.push({
        type: 'removed',
        name
      });
    }
  }

  return result;
}

/**
 * Renders the diff results as markdown.
 */
export function formatDiffMarkdown(diff: ContractDiffResult): string {
  const lines: string[] = [];

  lines.push('# Contract Semantic Diff Report');
  lines.push('');

  // Metadata changes
  const metaKeys = Object.keys(diff.metadata);
  if (metaKeys.length > 0) {
    lines.push('## Metadata Changes');
    for (const key of metaKeys) {
      const change = (diff.metadata as any)[key];
      lines.push(`- **${key}**: \`${change.from}\` &rarr; \`${change.to}\``);
    }
    lines.push('');
  }

  // Slot changes
  if (diff.slots.length > 0) {
    lines.push('## Slot Changes');
    for (const slot of diff.slots) {
      if (slot.type === 'added') {
        lines.push(`- **[NEW]** Slot \`${slot.name}\` was added.`);
      } else if (slot.type === 'removed') {
        lines.push(`- **[DELETE]** Slot \`${slot.name}\` was removed.`);
      } else if (slot.type === 'modified' && slot.changes) {
        lines.push(`- **[MODIFY]** Slot \`${slot.name}\` was updated:`);
        for (const [prop, val] of Object.entries(slot.changes)) {
          lines.push(`  - **${prop}**: \`${val.from}\` &rarr; \`${val.to}\``);
        }
      }
    }
    lines.push('');
  }

  // Rule changes
  if (diff.rules.length > 0) {
    lines.push('## Rule Changes');
    for (const rule of diff.rules) {
      if (rule.type === 'added') {
        lines.push(`- **[NEW]** Linter rule \`${rule.name}\` was added.`);
      } else if (rule.type === 'removed') {
        lines.push(`- **[DELETE]** Linter rule \`${rule.name}\` was removed.`);
      } else if (rule.type === 'modified' && rule.changes) {
        lines.push(`- **[MODIFY]** Linter rule \`${rule.name}\` was updated:`);
        for (const [prop, val] of Object.entries(rule.changes)) {
          lines.push(`  - **${prop}**: \`${val.from}\` &rarr; \`${val.to}\``);
        }
      }
    }
    lines.push('');
  }

  // Regressions
  if (diff.regressions.length > 0) {
    lines.push('## ⚠️ Regressions Detected');
    for (const reg of diff.regressions) {
      lines.push(`- **CAUTION**: ${reg}`);
    }
    lines.push('');
  } else {
    lines.push('## ✅ No Regressions Detected');
    lines.push('All structural modifications appear safe.');
  }

  return lines.join('\n');
}
