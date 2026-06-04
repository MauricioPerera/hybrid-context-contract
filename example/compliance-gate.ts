// Compliance gate: PII screening + full JSON-Schema governance (ajv) + signed
// system prompt for audit. Runs a clean case (passes) and a violating case
// (PII + invalid governance, blocked). Part of `npm run demo` (CASE 6).
import fs from 'fs';
import yaml from 'js-yaml';
import { Engine, ContextContractSchema, computeHash } from '../src/index.js';
import type { ContextContract } from '../src/index.js';
import { createAjvSchemaHandler } from '../src/adapters/ajv-schema.js';

const contract = ContextContractSchema.parse(
  yaml.load(fs.readFileSync('example/compliance-contract.yaml', 'utf8'))
) as ContextContract;

const SYSTEM = 'You are a compliance-bound support agent. Never repeat PII back. Answer only within the stated data classification and region.';

// The signed system prompt: any drift becomes a compliance incident.
const expectedHashes = { system: computeHash(SYSTEM) };

const engine = new Engine(contract, {
  ruleHandlers: { 'json-schema': createAjvSchemaHandler() }
});

function gate(label: string, inputs: Record<string, string>): boolean {
  const result = engine.assemble(inputs, expectedHashes);
  console.log(`\n=== ${label} ===`);
  console.log(`audit: contract=${result.metadata.contractVersion} tokens=${result.metadata.totalTokens} at=${result.metadata.timestamp}`);
  if (result.verdict.valid) {
    console.log('✅ APROBADO — contexto limpio, se puede llamar al modelo.');
    return true;
  }
  console.log('🛑 BLOQUEADO — no se llama al modelo. Incidencias:');
  for (const f of result.verdict.findings) {
    if (f.severity === 'error') console.log(`   - (${f.rule}) ${f.slot}: ${f.message}`);
  }
  return false;
}

// Case A — clean: valid governance, no PII.
const clean = gate('Caso A — solicitud conforme', {
  system: SYSTEM,
  governance: '{"data_classification":"confidential","consent":true,"region":"eu-west"}',
  case_notes: 'Customer reported a billing question. No identifiers stored.',
  user_message: 'Can you explain how my last invoice was calculated?'
});

// Case B — violations: bad governance (enum + type + missing) and PII in the message.
const blocked = gate('Caso B — PII + governance inválida', {
  system: SYSTEM,
  governance: '{"data_classification":"top-secret","consent":"yes"}',
  case_notes: 'Card on file 4111 1111 1111 1111 for customer.',
  user_message: 'My SSN is 123-45-6789 and email is jane.doe@example.com, please help.'
});

// The gate "passes" overall only if the clean case was approved AND the violating
// case was blocked — i.e. the contract behaves exactly as a compliance gate should.
const ok = clean && !blocked;
console.log(`\n${ok ? '✓' : '✗'} Gate de compliance ${ok ? 'correcto' : 'INESPERADO'}.`);
process.exit(ok ? 0 : 1);
