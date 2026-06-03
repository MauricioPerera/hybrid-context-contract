# Especificación del Contrato de Contexto Híbrido

- **Versión de la especificación:** 1.0.0
- **Estado:** Normativa (refleja la implementación de `src/`)
- **Alcance:** Define el formato del contrato, las reglas de validación, el algoritmo de presupuesto, la semántica de ensamblado y diffing, y el contrato de la CLI.

Las palabras clave **DEBE**, **NO DEBE**, **DEBERÍA** y **PUEDE** se interpretan en su sentido normativo habitual.

> **Nota de fidelidad:** Este documento describe el comportamiento *real* del motor en [src/engine.ts](src/engine.ts), [src/diff.ts](src/diff.ts), [src/types.ts](src/types.ts) y [src/cli.ts](src/cli.ts), incluyendo casos límite. Si el código y esta spec divergen, es un bug en uno de los dos y **DEBE** reportarse.

---

## 1. Modelo conceptual

Un **Contrato de Contexto Híbrido** trata el contexto enviado a un modelo probabilístico (LLM) como un artefacto estructurado, versionado y validado de forma **determinista**. El objetivo: que la única fuente de no-determinismo del sistema sea la inferencia interna del modelo.

El contrato declara:
- **Slots**: las secciones que componen el contexto, su origen y su orden.
- **Presupuesto de tokens**: cuántos tokens caben y cómo se reparten por prioridad.
- **Invariantes deterministas (reglas)**: validaciones puras ejecutadas sobre el payload antes de enviarlo al modelo.

---

## 2. Esquema del contrato

El contrato se escribe en YAML o JSON y se valida con Zod ([src/types.ts](src/types.ts)). Estructura raíz:

| Campo            | Tipo                  | Requerido | Restricciones                          |
|------------------|-----------------------|-----------|----------------------------------------|
| `version`        | string                | sí        | —                                      |
| `name`           | string                | sí        | —                                      |
| `maxTotalTokens` | number                | sí        | entero, positivo (`> 0`)               |
| `slots`          | array&lt;Slot&gt;     | sí        | —                                      |
| `rules`          | array&lt;Rule&gt;     | no        | por defecto `[]`                       |

Un contrato que no satisface el esquema **DEBE** ser rechazado (la CLI termina con exit `1` e imprime el error de Zod).

### 2.1 Definición de Slot

| Campo         | Tipo                                                   | Requerido | Por defecto | Restricciones            |
|---------------|--------------------------------------------------------|-----------|-------------|--------------------------|
| `name`        | string                                                 | sí        | —           | identifica el slot       |
| `source`      | `static` \| `dynamic` \| `state` \| `environment`      | sí        | —           | metadato de procedencia  |
| `priority`    | number                                                 | sí        | —           | entero, `>= 0`           |
| `maxTokens`   | number                                                 | no        | —           | entero, positivo         |
| `immutable`   | boolean                                                | no        | `false`     | —                        |
| `compaction`  | string                                                 | no        | `error`     | `error`, un built-in (`truncate`/`summarize`) o una estrategia personalizada registrada en el `Engine` |
| `format`      | `text` \| `json` \| `markdown`                         | no        | `text`      | metadato de formato      |
| `required`    | boolean                                                | no        | `true`      | —                        |
| `description` | string                                                 | no        | —           | documentación            |

**Semántica de `priority`:** menor número = mayor importancia. `priority: 0` se presupuesta primero. `source` y `format` son metadatos descriptivos: el motor no cambia su lógica de asignación según ellos (salvo que las reglas `schema` solo tienen sentido sobre contenido JSON).

### 2.2 Definición de Regla

| Campo        | Tipo                                                   | Requerido | Por defecto | Uso                                  |
|--------------|--------------------------------------------------------|-----------|-------------|--------------------------------------|
| `name`       | string                                                 | sí        | —           | identificador del hallazgo           |
| `type`       | string                                                 | sí        | —           | tipo de chequeo: un built-in (`regex`, `broken-ref`, `immutable-hash`, `schema`) o uno personalizado registrado en el `Engine` |
| `targetSlot` | string                                                 | sí        | —           | slot sobre el que opera              |
| `pattern`    | string                                                 | no        | —           | patrón regex (solo `regex`)          |
| `flags`      | string                                                 | no        | —           | flags regex; `g` se ignora (solo `regex`) |
| `negate`     | boolean                                                | no        | —           | invierte la condición (solo `regex`) |
| `schemaJson` | string                                                 | no        | —           | JSON Schema simplificado (solo `schema`) |
| `message`    | string                                                 | no        | —           | mensaje del hallazgo                 |
| `severity`   | `error` \| `warning` \| `info`                         | no        | `error`     | severidad del hallazgo               |

---

## 3. Tokenización (enchufable)

El conteo de tokens es **inyectable**. El motor depende solo de la interfaz `Tokenizer`, nunca de un tokenizador concreto:

```ts
interface Tokenizer {
  countTokens(text: string): number;
  truncateToTokens?(text: string, maxTokens: number): string; // opcional
}
const engine = new Engine(contract, { tokenizer });  // por defecto: heurístico
```

- **Por defecto (`heuristicTokenizer`)**: aproximación `1 token ≈ 4 caracteres`, `estimateTokens(t) = t === '' ? 0 : ceil(t.length / 4)`. Es **determinista** pero **no exacta** respecto al tokenizador real del modelo.
- **Adaptador real**: `gptTokenizer` (en `hybrid-context-contract/adapters/gpt-tokenizer`, requiere la dependencia opcional `gpt-tokenizer`) cuenta tokens BPE reales (cl100k_base). Vía CLI: `--tokenizer gpt`.

**Invariante de truncado:** `truncateToTokens(text, max, tokenizer)` devuelve el prefijo más largo cuyo coste en tokens es `<= max`, para **cualquier** tokenizador — usa `tokenizer.truncateToTokens` si existe, o una búsqueda binaria *surrogate-safe* sobre `countTokens`. Esto hace que el presupuesto (§4) se respete con el tokenizador que sea, no solo con la heurística.

---

## 4. Asignación de presupuesto (`allocateBudgets`)

El motor procesa los slots **ordenados por `priority` ascendente** (mayor importancia primero) y mantiene un contador `remainingTotalTokens`, inicializado a `maxTotalTokens`.

Para cada slot, con `raw = inputs[slot.name] || ''`:

1. **Slot requerido ausente** — si `slot.required` y `raw` es vacío/ausente:
   - hallazgo `error` con regla `required-slot-missing`; estado `omitted`; se continúa.
2. **Slot opcional ausente** — si `raw` es vacío/ausente y no es requerido:
   - estado `omitted`; se continúa (sin hallazgo).
3. **Límite efectivo del slot:**
   `slotLimit = slot.maxTokens ? min(slot.maxTokens, remainingTotalTokens) : remainingTotalTokens`.
4. **Cabe** (`requestedTokens <= slotLimit`): se asigna el texto íntegro; estado `ok`.
5. **No cabe** — según `compaction`:
   - `error` (política, no transformación): hallazgo `error` regla `budget-overflow-error`; texto vacío; estado `omitted`; `allocatedTokens = 0`.
   - cualquier otro valor: se despacha al **compactor** registrado con ese nombre (built-in o personalizado; ver §4.1). Si no hay compactor: hallazgo `error` regla `unknown-compaction-strategy`, `omitted`. El motor **recorta el resultado del compactor a `slotLimit`** si lo excede (garantía dura). `allocatedTokens = countTokens(finalText)`.
     - built-in `truncate`: `truncateToTokens(raw, slotLimit, tokenizer)`; estado `truncated`; `warning` `budget-truncated`.
     - built-in `summarize`: reserva el coste del marcador `\n\n[... Content truncated & summarized ...]`, trunca el cuerpo a `slotLimit - markerTokens`, concatena el marcador (y reclampa si excede); estado `summarized`; `warning` `budget-summarized`.
6. Tras asignar: `remainingTotalTokens -= allocatedTokens`.

**Invariante de presupuesto:** ningún slot **DEBE** producir un texto cuyo coste en tokens (medido con el tokenizador activo) supere su `slotLimit`. (Esto incluye `summarize`, que recorta el resultado final con el marcador incluido.)

**Nota de orden vs. salida:** la asignación ocurre en orden de prioridad, pero el ensamblado (§6) emite los slots en el **orden de definición** del contrato.

**Caso límite — cadena vacía:** una entrada `''` se trata como ausente (`raw || ''` ⇒ vacío). Un slot requerido con entrada vacía dispara `required-slot-missing`.

### 4.1 Compactores personalizados (extensibilidad)
La compactación se despacha a un `Compactor` (`(text, ctx) => { text, status?, findings? }`) buscado por el valor de `slot.compaction` en un registro (built-ins + inyectados):

```ts
const engine = new Engine(contract, {
  compactors: { 'llm-summary': async-free-wrapper-o-función-síncrona }
});
```

- `CompactionContext` expone: `slot`, `maxTokens`, `tokenizer`, `requestedTokens` y `truncateToTokens`.
- Un compactor personalizado con el mismo nombre que un built-in lo **sobrescribe**.
- **Garantía:** el motor recorta el resultado a `maxTokens` aunque el compactor se exceda, así que el invariante de presupuesto se mantiene incluso con compactores no confiables (p. ej. un resumen vía LLM). Los compactores son síncronos; para un resumen asíncrono, precalcúlalo y pásalo como input, o envuelve un cache síncrono.

---

## 5. Validación / Linter (`lint`)

Las reglas del contrato se ejecutan sobre los textos **ya asignados** (post-compactación). Cada regla se despacha a un **handler** registrado por su `type` (registro = built-ins + handlers personalizados inyectados; ver §5.7). Si no hay handler para el `type`, se emite un hallazgo `warning` con regla `unknown-rule-type` y la regla se omite. Tipos built-in:

### 5.1 `regex`
- Sin `pattern`: hallazgo `warning` regla `invalid-rule-config`; se omite la regla.
- Se compila `new RegExp(pattern, flags)` con el flag `g` eliminado (un `lastIndex` con estado rompería el determinismo de `.test()`).
- `matches = regex.test(targetText)`.
- Dispara hallazgo si: `negate ? matches : !matches`. Es decir:
  - sin `negate`: falla si **no** coincide (afirmar presencia obligatoria).
  - con `negate: true`: falla si **sí** coincide (prohibir patrón, p. ej. secretos/PII).
- Patrón inválido: hallazgo `error` regla `invalid-regex-syntax`.
- **Protección ReDoS:** antes de ejecutar, el patrón se analiza con una heurística (`isReDoSVulnerable`) que detecta cuantificadores anidados (star height ≥ 2, p. ej. `(a+)+`). Si se detecta, **no se ejecuta** y se emite `error` regla `unsafe-regex-pattern`. Además, el input se evalúa acotado a `maxInputLength` caracteres (por defecto 1.000.000) para acotar el peor caso. Es una heurística: cubre la clase dominante, no garantiza el 100%. Configurable/desactivable vía `createRegexRuleHandler({ rejectUnsafe, maxInputLength })`.

### 5.2 `schema`
- Si el texto del slot está vacío (tras `trim`): se omite.
- Se hace `JSON.parse`. Si falla: hallazgo `error` regla `<name>-invalid-json`.
- Si hay `schemaJson` con `required: string[]`: por cada clave ausente en el objeto, hallazgo con `severity` de la regla y regla `<name>`.
- Es una validación **simplificada**: solo comprueba presencia de claves de primer nivel listadas en `required`. No valida tipos ni estructuras anidadas.
- Para validación **completa** (tipos, anidados, enums, formatos), usa el adaptador opcional `ajv` registrando un handler `json-schema` (`createAjvSchemaHandler()` en `hybrid-context-contract/adapters/ajv-schema`, requiere la dependencia opcional `ajv`). Coexiste con el `schema` built-in.

### 5.3 `immutable-hash`
- Si el texto está vacío (tras `trim`): se omite.
- Compara `computeHash(texto)` (SHA-256 hex) contra `expectedHashes[targetSlot]`.
- Solo dispara si existe un hash esperado para ese slot y difiere; severidad = `severity` de la regla.

### 5.4 `broken-ref`
- Busca referencias `{slotName}` o `{slotName.key}` con la regex `/\{([a-zA-Z0-9_-]+)(?:\.[a-zA-Z0-9_-]+)?\}/g`.
- Por cada referencia cuyo `slotName` no exista en el contrato: hallazgo con `severity` de la regla, regla `<name>`.

### 5.5 Chequeo implícito de inmutabilidad
Independiente de las reglas, **para todo slot con `immutable: true`**:
- Si existe `expectedHashes[slot.name]` y el texto no está vacío, se compara `computeHash(texto)` con el hash esperado.
- Si difiere: hallazgo **`error`** (severidad fija) regla `immutable-slot-drift`.

> Diferencia con `immutable-hash` (§5.3): el chequeo implícito se activa por la bandera `immutable: true` del slot, su severidad es siempre `error`, y su regla es `immutable-slot-drift`. La regla `immutable-hash` es explícita, su severidad es configurable, y se nombra según `rule.name`.

### 5.6 Veredicto
```
verdict.valid = (ningún hallazgo tiene severity === 'error')
```
Los `warning` e `info` **no** invalidan el contexto.

### 5.7 Reglas personalizadas (extensibilidad)
El motor despacha cada regla a un `RuleHandler` (función pura `(RuleContext) => ValidationFinding[]`) buscado en un registro por `rule.type`. El registro se forma con los handlers built-in más los que se inyecten:

```ts
const engine = new Engine(contract, {
  ruleHandlers: { 'max-words': ({ rule, text }) => /* … */ [] }
});
```

- Un handler personalizado con el mismo `type` que un built-in lo **sobrescribe**.
- `RuleContext` expone: `rule`, `text` (del `targetSlot`), `allocatedTexts`, `contract`, `expectedHashes` y `computeHash`.
- El chequeo implícito de inmutabilidad (§5.5) **no** es una regla y no es extensible por esta vía.

---

## 6. Ensamblado (`assemble`)

1. Ejecuta `allocateBudgets` → textos asignados + uso + hallazgos de asignación.
2. Ejecuta `lint` → hallazgos de validación.
3. Agrega ambos conjuntos de hallazgos; `valid` = sin `error`.
4. Emite los slots **en orden de definición**, omitiendo los vacíos/ausentes. Cada slot se envuelve:
   ```
   === START SLOT: <name> ===
   <texto>
   === END SLOT: <name> ===
   ```
   y las secciones se unen con `\n\n`.
5. Metadata producida:

| Campo             | Descripción                                              |
|-------------------|----------------------------------------------------------|
| `slotUsage`       | mapa slot → `{ requestedTokens, allocatedTokens, status }` |
| `totalTokens`     | suma de `allocatedTokens` de los slots incluidos         |
| `timestamp`       | ISO-8601 del momento de ensamblado (**no determinista**) |
| `contractVersion` | `contract.version`                                       |

> El único campo no determinista del payload es `timestamp`. El `content` y el `verdict` son funciones puras de (contrato, inputs, hashes).

---

## 7. Diff semántico (`diffContracts`)

Compara dos contratos y produce cambios + regresiones.

**Cambios detectados:**
- Metadata: `version`, `name`, `maxTotalTokens`.
- Slots: `added` / `removed` / `modified` (campos comparados: `source`, `priority`, `maxTokens`, `immutable`, `compaction`, `format`, `required`).
- Reglas: `added` / `removed` / `modified` (campos: `type`, `targetSlot`, `severity`).

**Regresiones detectadas** (señales de degradación de política de contexto):
1. `maxTotalTokens` **disminuye** (riesgo de truncamiento inesperado).
2. La `priority` de un slot **aumenta** de valor (pierde importancia, se presupuesta más tarde → más expuesto a truncado).
3. Un slot **requerido** es **eliminado**.

El renderizado Markdown (`formatDiffMarkdown`) lista los cambios y, si no hay regresiones, emite "✅ No Regressions Detected".

---

## 8. Contrato de la CLI

Binario: `dist/src/cli.js`. Comandos y exit codes:

| Comando    | Opciones                                                       | Exit `0`                  | Exit `1`                                   |
|------------|----------------------------------------------------------------|---------------------------|--------------------------------------------|
| `lint`     | `--contract`, `--inputs`, `--hashes?`                          | `verdict.valid === true`  | hay hallazgos `error`                      |
| `assemble` | `--contract`, `--inputs`, `--output`, `--hashes?`              | `verdict.valid === true` (escribe el `--output`) | `verdict.valid === false` (**no** escribe) |
| `diff`     | `--old`, `--new`, `--format?` (`markdown`\|`json`)             | sin regresiones           | hay ≥1 regresión                           |
| `hash`     | `--contract`, `--inputs`, `--output?`, `--all?`                | siempre (firma y escribe/imprime) | error transversal                  |
| `spec`     | `--contract`                                                   | siempre (imprime JSON)    | —                                          |

**`hash`** genera/actualiza el archivo de hashes esperados. Por defecto firma solo los slots que el linter verifica contra firma — los `immutable: true` y los `targetSlot` de reglas `immutable-hash` —; con `--all` firma todos los slots presentes en los inputs. Si `--output` ya existe, **fusiona** sobre él (preserva entradas manuales). Sin `--output`, imprime el JSON por stdout. El hash se computa sobre el **contenido crudo del input** del slot (que coincide con el texto asignado cuando el slot no se compacta, como debe ser para un slot inmutable).

Condiciones de error transversales (exit `1`): archivo de contrato no encontrado, contrato que no valida el esquema, directorio de inputs no encontrado, opciones requeridas ausentes. Un archivo de hashes ausente produce **warning** y se continúa sin chequeos de hash.

**Convención de inputs:** cada archivo del directorio de inputs se mapea a un slot por su **nombre base sin extensión** (p. ej. `system.txt` → slot `system`, `metadata.json` → slot `metadata`).

> **Garantía de seguridad:** `assemble` **NO escribe el archivo de salida si la validación falla** — imprime los hallazgos de severidad `error` y termina con exit `1`. Esto evita persistir a disco un payload con secretos filtrados o un prompt manipulado. El `--output` solo se produce con un veredicto limpio.

---

## 9. Funciones criptográficas

`computeHash(text)` = SHA-256 del texto en UTF-8, en hexadecimal. Se usa para firmar slots inmutables y detectar drift. Los hashes esperados se proveen como un mapa `{ slotName: hashHex }` (archivo JSON en la CLI, parámetro en la API).

---

## 10. Compatibilidad y versionado

- El campo `version` del contrato es definido por el autor del contrato y es libre.
- La **versión de esta especificación** (1.0.0) describe el formato y la semántica del motor.
- Cambios que rompan la semántica descrita aquí **DEBEN** incrementar la versión de la especificación.
