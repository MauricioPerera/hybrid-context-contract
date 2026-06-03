// Orquestador de demos: ejecuta los 4 casos de uso en orden y reporta.
// Ejecutar:  npm run demo
//
// Nota: los casos 2, 3 y 4 *deben* terminar con exit 1 (el contrato bloquea
// el contexto). Tratamos ese exit como "comportamiento esperado", no como
// fallo del demo. El demo en su conjunto falla solo si algún caso se desvía
// del exit code esperado.
import { spawnSync } from 'node:child_process';

interface Case {
  title: string;
  detail: string;
  cmd: string[];
  expectedExit: number;
}

const cases: Case[] = [
  {
    title: 'CASO 1 — PR válido: ensamblar contexto para el LLM',
    detail: 'El contrato presupuesta y ensambla un payload limpio.',
    cmd: ['dist/src/cli.js', 'assemble',
      '--contract', 'example/agent-contract.yaml',
      '--inputs', 'example/inputs',
      '--hashes', 'example/expected-hashes.json',
      '--output', 'example/scenario-assembled.txt'],
    expectedExit: 0
  },
  {
    title: 'CASO 2 — Secreto hardcodeado en el diff: bloqueado',
    detail: 'La regla regex no-secrets-allowed detecta sk_live_... antes de llamar al LLM.',
    cmd: ['dist/src/cli.js', 'lint',
      '--contract', 'example/agent-contract.yaml',
      '--inputs', 'example/scenario-bad',
      '--hashes', 'example/expected-hashes.json'],
    expectedExit: 1
  },
  {
    title: 'CASO 3 — System prompt inmutable manipulado: bloqueado',
    detail: 'El SHA-256 firmado detecta el drift (prompt injection).',
    cmd: ['dist/src/cli.js', 'lint',
      '--contract', 'example/agent-contract.yaml',
      '--inputs', 'example/scenario-drift',
      '--hashes', 'example/expected-hashes.json'],
    expectedExit: 1
  },
  {
    title: 'CASO 4 — Guardia programática (API del Engine): bloqueado',
    detail: 'El mismo motor embebido en backend rechaza el contexto sin llamar al LLM.',
    cmd: ['dist/example/demo-gate.js'],
    expectedExit: 1
  }
];

let allOk = true;
const summary: string[] = [];

for (const c of cases) {
  console.log('\n############################################################');
  console.log(`# ${c.title}`);
  console.log(`# ${c.detail}`);
  console.log('############################################################');

  const res = spawnSync('node', c.cmd, { stdio: 'inherit' });
  const exit = res.status ?? 1;
  const ok = exit === c.expectedExit;
  allOk = allOk && ok;

  const verdict = ok
    ? `OK (exit ${exit}, esperado ${c.expectedExit})`
    : `DESVIACIÓN (exit ${exit}, esperado ${c.expectedExit})`;
  console.log(`>>> ${ok ? '✅' : '❌'} ${verdict}`);
  summary.push(`${ok ? '✅' : '❌'} ${c.title.split(':')[0].trim()} — ${verdict}`);
}

console.log('\n============================================================');
console.log('RESUMEN');
console.log('============================================================');
for (const line of summary) console.log(line);
console.log('');

process.exit(allOk ? 0 : 1);
