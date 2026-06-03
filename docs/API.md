# Referencia de la API Programática

Esta es la referencia de los símbolos exportados por el paquete (`src/index.ts`). Para la semántica completa, ver [SPEC.md](../SPEC.md).

```ts
import { Engine, computeHash, estimateTokens, diffContracts, formatDiffMarkdown,
         ContextContractSchema /* + tipos */ } from 'hybrid-context-contract';
```

---

## `class Engine`

Motor de ensamblado y validación. Se construye con un contrato ya validado y, opcionalmente, un tokenizador.

```ts
const engine = new Engine(contract /* : ContextContract */, {
  tokenizer,     /* ?: Tokenizer — por defecto, heurístico 4 chars/token */
  ruleHandlers,  /* ?: Record<string, RuleHandler> — reglas personalizadas (sobrescriben built-ins por tipo) */
  compactors     /* ?: Record<string, Compactor> — estrategias de compactación (sobrescriben built-ins por nombre) */
});
```

### `engine.assemble(inputs, expectedHashes?) → AssembledPayload`

Punto de entrada principal. Asigna presupuestos, ejecuta el linter y construye el payload final.

| Parámetro        | Tipo                          | Descripción                                            |
|------------------|-------------------------------|--------------------------------------------------------|
| `inputs`         | `Record<string, string>`      | Texto por nombre de slot.                              |
| `expectedHashes` | `Record<string, string>?`     | Hashes SHA-256 esperados por slot (para drift/immutable). |

Devuelve `AssembledPayload` (ver abajo). Es una función pura salvo por `metadata.timestamp`.

### `engine.allocateBudgets(inputs)`

Solo la fase de presupuesto. Devuelve `{ allocatedTexts, usage, findings }`. Útil para inspeccionar la asignación sin ensamblar. Ver §4 de [SPEC.md](../SPEC.md).

### `engine.lint(allocatedTexts, usage, expectedHashes?) → ValidationVerdict`

Solo la fase de validación, sobre textos ya asignados. Ver §5 de [SPEC.md](../SPEC.md).

---

## Funciones utilitarias

### `estimateTokens(text: string): number`
`text === '' ? 0 : Math.ceil(text.length / 4)`. Aproximación 1 token ≈ 4 caracteres.

### `heuristicTokenizer: Tokenizer`
Tokenizador por defecto del `Engine`, basado en `estimateTokens`.

### `truncateToTokens(text, maxTokens, tokenizer): string`
Prefijo más largo de `text` cuyo coste en tokens es `<= maxTokens`, para cualquier tokenizador (búsqueda binaria *surrogate-safe* si el tokenizador no aporta truncado nativo).

### Adaptador: `gptTokenizer` — `hybrid-context-contract/adapters/gpt-tokenizer`
Tokenizador BPE real (OpenAI cl100k_base) vía la dependencia opcional `gpt-tokenizer`:
```ts
import { gptTokenizer } from 'hybrid-context-contract/adapters/gpt-tokenizer';
const engine = new Engine(contract, { tokenizer: gptTokenizer });
```

### `computeHash(text: string): string`
SHA-256 hex del texto en UTF-8.

### `diffContracts(oldContract, newContract): ContractDiffResult`
Diff semántico entre dos contratos. Ver §7 de [SPEC.md](../SPEC.md).

### `formatDiffMarkdown(diff: ContractDiffResult): string`
Renderiza un `ContractDiffResult` como Markdown legible.

---

## Tipos principales

### `Tokenizer`
```ts
{
  countTokens(text: string): number;
  truncateToTokens?(text: string, maxTokens: number): string;  // opcional
}
```

### `RuleHandler` / `RuleContext`
```ts
type RuleHandler = (ctx: RuleContext) => ValidationFinding[];

interface RuleContext {
  rule: DeterministicCheckRule;
  text: string;                          // texto asignado del targetSlot
  allocatedTexts: Record<string, string>;
  contract: ContextContract;
  expectedHashes?: Record<string, string>;
  computeHash: (text: string) => string;
}
```
Los handlers built-in se exportan como `builtinRuleHandlers: Record<string, RuleHandler>`. Un handler personalizado con el mismo tipo sobrescribe al built-in. Un `type` sin handler produce un hallazgo `warning` (`unknown-rule-type`).

### `Compactor` / `CompactionContext` / `CompactionResult`
```ts
type Compactor = (text: string, ctx: CompactionContext) => CompactionResult;

interface CompactionContext {
  slot: SlotDefinition;
  maxTokens: number;               // presupuesto a respetar
  tokenizer: Tokenizer;
  requestedTokens: number;         // tokens del texto original
  truncateToTokens: (text: string, maxTokens: number, tokenizer: Tokenizer) => string;
}
interface CompactionResult {
  text: string;                    // el motor lo recorta a maxTokens si excede
  status?: 'truncated' | 'summarized';
  findings?: ValidationFinding[];
}
```
Built-ins exportados como `builtinCompactors: Record<string, Compactor>` (`truncate`, `summarize`). Se seleccionan por `slot.compaction`; `error` es especial (falla, no compacta). Una estrategia sin compactor produce un hallazgo `error` (`unknown-compaction-strategy`).

### Adaptador: `createAjvSchemaHandler` — `hybrid-context-contract/adapters/ajv-schema`
Handler de regla con JSON Schema completo (Ajv, draft-07+), vía la dependencia opcional `ajv`. Regístralo como tipo de regla (recomendado `json-schema`, para coexistir con el `schema` built-in):
```ts
import { createAjvSchemaHandler } from 'hybrid-context-contract/adapters/ajv-schema';
const engine = new Engine(contract, { ruleHandlers: { 'json-schema': createAjvSchemaHandler() } });
```
El `schemaJson` de la regla contiene el esquema (string JSON); se valida contra el contenido parseado del `targetSlot`. Los validadores se cachean por esquema.

### `ContextContract`
```ts
{
  version: string;
  name: string;
  maxTotalTokens: number;   // entero positivo
  slots: SlotDefinition[];
  rules: DeterministicCheckRule[];  // por defecto []
}
```
Valídalo con `ContextContractSchema.safeParse(obj)` antes de instanciar el `Engine`.

### `SlotDefinition`
```ts
{
  name: string;
  source: 'static' | 'dynamic' | 'state' | 'environment';
  priority: number;          // entero >= 0; menor = mayor prioridad
  maxTokens?: number;        // entero positivo
  immutable?: boolean;       // default false
  compaction?: 'truncate' | 'summarize' | 'error';  // default 'error'
  format?: 'text' | 'json' | 'markdown';            // default 'text'
  required?: boolean;        // default true
  description?: string;
}
```

### `DeterministicCheckRule`
```ts
{
  name: string;
  type: 'regex' | 'broken-ref' | 'immutable-hash' | 'schema';
  targetSlot: string;
  pattern?: string;          // solo 'regex'
  flags?: string;            // solo 'regex'; el flag 'g' se ignora
  negate?: boolean;          // solo 'regex'
  schemaJson?: string;       // solo 'schema'
  message?: string;
  severity?: 'error' | 'warning' | 'info';  // default 'error'
}
```

### `AssembledPayload`
```ts
{
  content: string;             // payload final, slots envueltos y en orden de definición
  metadata: {
    slotUsage: Record<string, { requestedTokens: number; allocatedTokens: number;
                                status: 'ok' | 'truncated' | 'summarized' | 'omitted' }>;
    totalTokens: number;
    timestamp: string;         // ISO-8601 (único campo no determinista)
    contractVersion: string;
  };
  verdict: {
    valid: boolean;            // true si no hay hallazgos de severidad 'error'
    findings: Array<{ severity: 'error' | 'warning' | 'info';
                      rule: string; message: string; slot?: string }>;
  };
}
```

---

## Patrón de uso: guardia previa al LLM

```ts
import yaml from 'js-yaml';
import fs from 'fs';
import { Engine, ContextContractSchema, ContextContract } from 'hybrid-context-contract';

const raw = yaml.load(fs.readFileSync('contract.yaml', 'utf8'));
const contract = ContextContractSchema.parse(raw) as ContextContract;

const engine = new Engine(contract);
const result = engine.assemble(inputs, expectedHashes);

if (!result.verdict.valid) {
  // NO llamar al LLM. Registrar/abortar.
  throw new Error(result.verdict.findings.map(f => `[${f.rule}] ${f.message}`).join('\n'));
}
await llm.complete(result.content);
```

Ver un ejemplo ejecutable en [example/demo-gate.ts](../example/demo-gate.ts) (`npm run demo`, CASO 4).
