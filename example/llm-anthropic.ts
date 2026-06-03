// Ejemplo de integración real: Contrato -> tokenizador real -> gate -> LLM.
//
// Flujo:
//   1. Carga y valida el contrato.
//   2. Ensambla el contexto usando el tokenizador BPE real (presupuesto exacto).
//   3. Si la validación falla, NO llama al modelo.
//   4. Si pasa, llama a la API de Anthropic (o hace dry-run si no hay API key).
//
// Para la llamada real:
//   npm i @anthropic-ai/sdk
//   export ANTHROPIC_API_KEY=sk-ant-...
//   node dist/example/llm-anthropic.js
import fs from 'fs';
import yaml from 'js-yaml';
import { Engine, ContextContractSchema, ContextContract } from '../src/index.js';
import { gptTokenizer } from '../src/adapters/gpt-tokenizer.js';

async function main() {
  // 1. Cargar y validar el contrato
  const raw = yaml.load(fs.readFileSync('example/agent-contract.yaml', 'utf8'));
  const contract = ContextContractSchema.parse(raw) as ContextContract;

  const inputs: Record<string, string> = {
    system: fs.readFileSync('example/inputs/system.txt', 'utf8'),
    guidelines: fs.readFileSync('example/inputs/guidelines.txt', 'utf8'),
    metadata: fs.readFileSync('example/inputs/metadata.json', 'utf8'),
    changed_code: fs.readFileSync('example/inputs/changed_code.txt', 'utf8'),
    user_message: fs.readFileSync('example/inputs/user_message.txt', 'utf8')
  };
  const expectedHashes = JSON.parse(fs.readFileSync('example/expected-hashes.json', 'utf8'));

  // 2. Ensamblar con presupuesto de tokens REAL (BPE de OpenAI vía gpt-tokenizer)
  const engine = new Engine(contract, { tokenizer: gptTokenizer });
  const result = engine.assemble(inputs, expectedHashes);

  // 3. Gate determinista
  if (!result.verdict.valid) {
    console.error('🛑 Contexto RECHAZADO por el contrato. No se llama al LLM.');
    for (const f of result.verdict.findings) {
      if (f.severity === 'error') console.error(`   - (${f.rule}) ${f.slot}: ${f.message}`);
    }
    process.exit(1);
  }
  console.log(`✅ Contexto válido: ${result.metadata.totalTokens} tokens (tokenizador real).`);

  // El payload ensamblado lleva los slots etiquetados; lo usamos como system prompt.
  const systemPrompt = result.content;

  // 4. Llamada al modelo (o dry-run si no hay API key / SDK)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n[dry-run] ANTHROPIC_API_KEY no definido. Payload que se habría enviado:\n');
    console.log(systemPrompt);
    return;
  }

  // Import dinámico con especificador computado: el build NO depende del SDK.
  const pkg = '@anthropic-ai/sdk';
  let Anthropic: any;
  try {
    const mod: any = await import(pkg);
    Anthropic = mod.default ?? mod;
  } catch {
    console.error(`Falta la dependencia opcional. Instálala con: npm i ${pkg}`);
    process.exit(1);
  }

  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-3-5-haiku-latest',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Procede con la revisión según el contexto del sistema.' }]
  });

  console.log('\n=== Respuesta del modelo ===');
  for (const block of message.content) {
    if (block.type === 'text') console.log(block.text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
