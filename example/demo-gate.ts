// Demo: usar el contrato como "guardia" antes de llamar al LLM en un backend.
// Se ejecuta como parte de `npm run demo` (CASO 4).
import fs from 'fs';
import yaml from 'js-yaml';
import { Engine } from '../src/engine.js';
import { ContextContract } from '../src/types.js';

const contract = yaml.load(
  fs.readFileSync('example/agent-contract.yaml', 'utf8')
) as ContextContract;

const expectedHashes = JSON.parse(
  fs.readFileSync('example/expected-hashes.json', 'utf8')
);

const engine = new Engine(contract);

// Entradas recolectadas en runtime (system/guidelines estáticos, el resto dinámico).
const inputs: Record<string, string> = {
  system: fs.readFileSync('example/inputs/system.txt', 'utf8'),
  guidelines: fs.readFileSync('example/inputs/guidelines.txt', 'utf8'),
  metadata: fs.readFileSync('example/inputs/metadata.json', 'utf8'),
  changed_code: 'const password = "hunter2hunter2hunter2";', // <- secreto inyectado
  user_message: 'Revisa este cambio, por favor.'
};

const result = engine.assemble(inputs, expectedHashes);

if (result.verdict.valid) {
  console.log(`✅ Contexto válido (${result.metadata.totalTokens} tokens). Llamando al LLM...`);
  // await llm.complete(result.content)
} else {
  console.error('🛑 Contexto RECHAZADO. No se llama al LLM. Hallazgos:');
  for (const f of result.verdict.findings) {
    console.error(`   - [${f.severity}] (${f.rule}) ${f.slot}: ${f.message}`);
  }
  process.exit(1);
}
