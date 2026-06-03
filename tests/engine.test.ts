import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Engine, computeHash } from '../src/engine.js';
import { diffContracts } from '../src/diff.js';
import { ContextContract } from '../src/types.js';

describe('Hybrid Context Contract Engine', () => {
  const mockContract: ContextContract = {
    version: '1.0.0',
    name: 'test-agent-contract',
    maxTotalTokens: 100, // Very small token window for easy testing
    slots: [
      {
        name: 'system',
        source: 'static',
        priority: 0, // Highest priority
        immutable: true,
        compaction: 'error',
        format: 'text',
        required: true
      },
      {
        name: 'policies',
        source: 'static',
        priority: 1,
        immutable: false,
        compaction: 'error',
        format: 'text',
        required: true
      },
      {
        name: 'memory',
        source: 'state',
        priority: 2,
        immutable: false,
        compaction: 'summarize',
        format: 'text',
        required: false
      },
      {
        name: 'user_input',
        source: 'dynamic',
        priority: 3, // Lowest priority, gets truncated/summarized first
        immutable: false,
        compaction: 'truncate',
        format: 'text',
        required: true
      }
    ],
    rules: [
      {
        name: 'no-pii-regex',
        type: 'regex',
        targetSlot: 'user_input',
        pattern: '\\b\\d{3}-\\d{2}-\\d{4}\\b', // SSN pattern
        negate: true, // Fail if matched
        severity: 'error',
        message: 'PII pattern detected in user input.'
      },
      {
        name: 'cross-slot-references',
        type: 'broken-ref',
        targetSlot: 'policies',
        severity: 'warning'
      }
    ]
  };

  it('should successfully allocate budgets when within total budget', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'You are an assistant.', // ~6 tokens
      policies: 'Always be polite.', // ~5 tokens
      memory: 'User likes coffee.', // ~5 tokens
      user_input: 'Hello world!' // ~3 tokens
    };

    const result = engine.assemble(inputs);
    assert.strictEqual(result.verdict.valid, true);
    assert.strictEqual(result.metadata.slotUsage['system'].status, 'ok');
    assert.strictEqual(result.metadata.slotUsage['user_input'].status, 'ok');
    assert.ok(result.content.includes('You are an assistant.'));
  });

  it('should enforce priorities and truncate low-priority slot when budget is exceeded', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'You are an assistant.', // ~6 tokens
      policies: 'Always be polite.'.repeat(2), // ~9 tokens
      memory: 'User likes coffee.'.repeat(25), // ~113 tokens (exceeds remaining 85)
      user_input: 'Hello world!'.repeat(10) // ~30 tokens (receives 0)
    };

    const result = engine.assemble(inputs);
    // Budget was exceeded (total tokens = 136, maxTotalTokens = 100)
    // Priority order:
    // system (0) -> policies (1) -> memory (2) -> user_input (3)
    // system = 6 tokens (fits)
    // policies = 50 tokens (fits, 56 used)
    // memory = 50 tokens (only 44 fits -> compaction 'summarize' triggers, fits 44 tokens)
    // user_input = 30 tokens (0 tokens left -> compaction 'truncate' triggers, fits 0 tokens)

    assert.strictEqual(result.metadata.slotUsage['system'].status, 'ok');
    assert.strictEqual(result.metadata.slotUsage['policies'].status, 'ok');
    assert.strictEqual(result.metadata.slotUsage['memory'].status, 'summarized');
    assert.strictEqual(result.metadata.slotUsage['user_input'].status, 'truncated');

    // It should have warnings, but valid is true because no 'error' severity triggers (only warnings for truncation/summary)
    assert.strictEqual(result.verdict.valid, true);
    const hasWarnings = result.verdict.findings.some(f => f.severity === 'warning');
    assert.strictEqual(hasWarnings, true);
  });

  it('should not exceed the slot budget when summarizing', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'Sys.',
      policies: 'Pol.',
      memory: 'A long memory entry. '.repeat(50), // far exceeds remaining budget
      user_input: 'Hi'
    };

    const result = engine.assemble(inputs);
    const memUsage = result.metadata.slotUsage['memory'];
    assert.strictEqual(memUsage.status, 'summarized');
    // The compacted content (including the marker) must fit within the allocation.
    const memText = result.content.includes('memory')
      ? result.content.split('=== START SLOT: memory ===\n')[1].split('\n=== END SLOT')[0]
      : '';
    assert.ok(memText.length <= memUsage.allocatedTokens * 4,
      `summarized text (${memText.length} chars) exceeds allocated budget (${memUsage.allocatedTokens * 4} chars)`);
  });

  it('should honor case-insensitive regex flags', () => {
    const contractWithFlags: ContextContract = {
      ...mockContract,
      rules: [
        {
          name: 'no-forbidden-word',
          type: 'regex',
          targetSlot: 'user_input',
          pattern: 'forbidden',
          flags: 'i',
          negate: true,
          severity: 'error',
          message: 'Forbidden word detected.'
        }
      ]
    };
    const engine = new Engine(contractWithFlags);
    const result = engine.assemble({
      system: 'Sys.',
      policies: 'Pol.',
      user_input: 'This is FORBIDDEN content.'
    });
    assert.strictEqual(result.verdict.valid, false);
    assert.ok(result.verdict.findings.some(f => f.rule === 'no-forbidden-word'));
  });

  it('should trigger regex error when forbidden patterns are matched', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'System instructions.',
      policies: 'Policies text.',
      user_input: 'My SSN is 123-45-6789. Do not leak it!'
    };

    const result = engine.assemble(inputs);
    assert.strictEqual(result.verdict.valid, false);
    const piiFinding = result.verdict.findings.find(f => f.rule === 'no-pii-regex');
    assert.ok(piiFinding);
    assert.strictEqual(piiFinding.severity, 'error');
  });

  it('should detect broken cross-slot references', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'System instructions.',
      policies: 'According to {non_existent_slot}, we should fail.',
      user_input: 'Valid user input.'
    };

    const result = engine.assemble(inputs);
    // valid is true here because rule cross-slot-references severity is set to 'warning'
    assert.strictEqual(result.verdict.valid, true);
    const refFinding = result.verdict.findings.find(f => f.rule === 'cross-slot-references');
    assert.ok(refFinding);
    assert.strictEqual(refFinding.severity, 'warning');
    assert.ok(refFinding.message.includes('non_existent_slot'));
  });

  it('should fail when immutable slot content drifts', () => {
    const engine = new Engine(mockContract);
    const inputs = {
      system: 'Original System instructions.',
      policies: 'Policies text.',
      user_input: 'Valid user input.'
    };

    // Calculate original hash
    const expectedHash = computeHash('Original System instructions.');
    
    // Assemble with correct hash
    let result = engine.assemble(inputs, { system: expectedHash });
    assert.strictEqual(result.verdict.valid, true);

    // Modify system input
    const tamperedInputs = {
      ...inputs,
      system: 'Tampered System instructions.'
    };

    result = engine.assemble(tamperedInputs, { system: expectedHash });
    assert.strictEqual(result.verdict.valid, false);
    const driftFinding = result.verdict.findings.find(f => f.rule === 'immutable-slot-drift');
    assert.ok(driftFinding);
    assert.strictEqual(driftFinding.severity, 'error');
  });
});

describe('Contract Semantic Diff Engine', () => {
  const v1: ContextContract = {
    version: '1.0.0',
    name: 'test-contract',
    maxTotalTokens: 1000,
    slots: [
      { name: 'system', source: 'static', priority: 0, required: true, compaction: 'error', format: 'text', immutable: true },
      { name: 'user_input', source: 'dynamic', priority: 1, required: true, compaction: 'truncate', format: 'text', immutable: false }
    ],
    rules: []
  };

  it('should detect added, modified and removed slots', () => {
    const v2: ContextContract = {
      version: '1.1.0',
      name: 'test-contract',
      maxTotalTokens: 800, // Reduced budget (regression!)
      slots: [
        // system priority changed from 0 to 1 (regression!)
        { name: 'system', source: 'static', priority: 1, required: true, compaction: 'error', format: 'text', immutable: true },
        // user_input removed
        // new_slot added
        { name: 'new_slot', source: 'environment', priority: 0, required: false, compaction: 'truncate', format: 'text', immutable: false }
      ],
      rules: []
    };

    const diff = diffContracts(v1, v2);

    assert.strictEqual(diff.metadata.version?.to, '1.1.0');
    assert.strictEqual(diff.metadata.maxTotalTokens?.to, 800);

    const added = diff.slots.find(s => s.name === 'new_slot');
    assert.ok(added);
    assert.strictEqual(added.type, 'added');

    const removed = diff.slots.find(s => s.name === 'user_input');
    assert.ok(removed);
    assert.strictEqual(removed.type, 'removed');

    const modified = diff.slots.find(s => s.name === 'system');
    assert.ok(modified);
    assert.strictEqual(modified.type, 'modified');
    assert.strictEqual(modified.changes?.priority?.to, 1);

    // Verify regressions detected
    assert.strictEqual(diff.regressions.length, 3);
    assert.ok(diff.regressions.some(r => r.includes('Total token window budget decreased')));
    assert.ok(diff.regressions.some(r => r.includes('Priority of slot "system" was lowered')));
    assert.ok(diff.regressions.some(r => r.includes('Required slot "user_input" was removed')));
  });
});

describe('Schema and immutable-hash rules', () => {
  const baseContract: ContextContract = {
    version: '1.0.0',
    name: 'rules-contract',
    maxTotalTokens: 1000,
    slots: [
      { name: 'config', source: 'environment', priority: 0, required: true, compaction: 'error', format: 'json', immutable: false },
      { name: 'system', source: 'static', priority: 1, required: true, compaction: 'error', format: 'text', immutable: false }
    ],
    rules: [
      {
        name: 'config-schema',
        type: 'schema',
        targetSlot: 'config',
        schemaJson: '{"required": ["user_role", "env"]}',
        severity: 'error'
      },
      {
        name: 'system-immutable-hash',
        type: 'immutable-hash',
        targetSlot: 'system',
        severity: 'error'
      }
    ]
  };

  it('should pass schema check when all required keys are present', () => {
    const engine = new Engine(baseContract);
    const result = engine.assemble({
      config: '{"user_role": "admin", "env": "prod"}',
      system: 'Sys.'
    });
    assert.strictEqual(result.verdict.findings.some(f => f.rule === 'config-schema'), false);
  });

  it('should flag a missing required schema key', () => {
    const engine = new Engine(baseContract);
    const result = engine.assemble({
      config: '{"user_role": "admin"}', // missing "env"
      system: 'Sys.'
    });
    const finding = result.verdict.findings.find(f => f.rule === 'config-schema');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'error');
    assert.ok(finding.message.includes('env'));
    assert.strictEqual(result.verdict.valid, false);
  });

  it('should flag malformed JSON in a schema-checked slot', () => {
    const engine = new Engine(baseContract);
    const result = engine.assemble({
      config: '{not valid json}',
      system: 'Sys.'
    });
    const finding = result.verdict.findings.find(f => f.rule === 'config-schema-invalid-json');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'error');
    assert.strictEqual(result.verdict.valid, false);
  });

  it('should pass immutable-hash when the hash matches', () => {
    const engine = new Engine(baseContract);
    const systemText = 'Frozen system prompt.';
    const result = engine.assemble(
      { config: '{"user_role": "a", "env": "b"}', system: systemText },
      { system: computeHash(systemText) }
    );
    assert.strictEqual(result.verdict.findings.some(f => f.rule === 'system-immutable-hash'), false);
  });

  it('should flag immutable-hash drift when the hash differs', () => {
    const engine = new Engine(baseContract);
    const result = engine.assemble(
      { config: '{"user_role": "a", "env": "b"}', system: 'Changed system prompt.' },
      { system: computeHash('Original system prompt.') }
    );
    const finding = result.verdict.findings.find(f => f.rule === 'system-immutable-hash');
    assert.ok(finding);
    assert.strictEqual(finding.severity, 'error');
    assert.strictEqual(result.verdict.valid, false);
  });
});

describe('CLI (end-to-end against example fixtures)', () => {
  const CLI = 'dist/src/cli.js';

  // Runs the CLI and returns { status, stdout }. execFileSync throws on a
  // non-zero exit, so we normalize both paths into a single shape.
  function runCli(args: string[]): { status: number; stdout: string } {
    try {
      const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
      return { status: 0, stdout };
    } catch (e: any) {
      return { status: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
    }
  }

  it('spec: prints the parsed contract as JSON and exits 0', () => {
    const { status, stdout } = runCli(['spec', '--contract', 'example/agent-contract.yaml']);
    assert.strictEqual(status, 0);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.name, 'CodeReviewAgentContract');
    assert.ok(Array.isArray(parsed.slots) && parsed.slots.length > 0);
  });

  it('lint: passes the valid example with matching hashes and exits 0', () => {
    const { status, stdout } = runCli([
      'lint',
      '--contract', 'example/agent-contract.yaml',
      '--inputs', 'example/inputs',
      '--hashes', 'example/expected-hashes.json'
    ]);
    assert.strictEqual(status, 0);
    assert.ok(stdout.includes('PASSED'));
  });

  it('assemble: refuses to write the output file when validation fails', () => {
    const outPath = 'example/scenario-should-not-exist.txt';
    if (fs.existsSync(outPath)) fs.rmSync(outPath);

    const { status } = runCli([
      'assemble',
      '--contract', 'example/agent-contract.yaml',
      '--inputs', 'example/scenario-bad', // contains a hardcoded secret
      '--hashes', 'example/expected-hashes.json',
      '--output', outPath
    ]);

    assert.strictEqual(status, 1);
    assert.strictEqual(fs.existsSync(outPath), false,
      'assemble must not write the payload when the verdict is invalid');
  });

  it('diff: detects regressions between v1 and v2 and exits 1', () => {
    const { status, stdout } = runCli([
      'diff',
      '--old', 'example/agent-contract.yaml',
      '--new', 'example/agent-contract-v2.yaml',
      '--format', 'json'
    ]);
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.regressions) && parsed.regressions.length > 0);
  });
});
