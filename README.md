# Hybrid Context Contract (Contratos de Contexto Híbrido)

Este proyecto implementa un framework agnóstico para definir, mezclar y validar **Contratos de Contexto Híbrido** con **validación determinista** para LLMs y sistemas de agentes.

El objetivo principal es tratar el contexto enviado a un modelo probabilístico (como un LLM) como un artefacto estructurado, versionado y validado en tiempo de compilación/ejecución, asegurando que la única parte no-determinista del sistema sea la inferencia interna del modelo.

> 📑 **Documentación:** [Especificación normativa (`SPEC.md`)](SPEC.md) · [Referencia de la API (`docs/API.md`)](docs/API.md)

---

## 📖 Concepto General

Un **Contrato de Contexto Híbrido** es una especificación estructural que declara:
- **Slots (Secciones)**: Qué datos componen el contexto, su origen (estáticos, dinámicos, con estado o de entorno) y su orden relativo de inserción.
- **Límites de Presupuesto (Token Budgeting)**: Asignación de tokens por prioridad. Si el contenido supera la ventana, se aplican estrategias de compactación (recorte o resumen) en cascada desde la menor prioridad a la mayor.
- **Invariantes Deterministas**: Validaciones programáticas puras ejecutadas sobre el payload de contexto antes de enviarlo al modelo, tales como reglas de expresiones regulares, esquemas JSON, detección de referencias rotas, o firmas SHA-256 de inmutabilidad.

---

## 🛠️ Estructura del Contrato (`CONTEXT.yaml`)

El contrato se escribe en YAML o JSON bajo el esquema validado por Zod. Ejemplo básico:

```yaml
version: "1.0.0"
name: "MyAgentContract"
maxTotalTokens: 2000

slots:
  - name: "system"
    source: "static"
    priority: 0
    immutable: true
    compaction: "error"
    required: true

  - name: "guidelines"
    source: "static"
    priority: 1
    immutable: false
    compaction: "error"
    maxTokens: 400
    required: true

  - name: "user_message"
    source: "dynamic"
    priority: 2
    compaction: "truncate"
    required: true

rules:
  - name: "no-secrets"
    type: "regex"
    targetSlot: "user_message"
    pattern: "(api_key|password)\\s*=\\s*['\"][a-zA-Z0-9]{16,}['\"]"
    negate: true
    severity: "error"
    message: "Se detectó una credencial en el mensaje del usuario."

  - name: "check-broken-refs"
    type: "broken-ref"
    targetSlot: "user_message"
    severity: "warning"
```

---

## 💻 Uso de la CLI

El proyecto incluye una CLI ejecutable directamente con Node.

### 1. Validar e Inspeccionar Entradas (`lint`)
Compara los archivos de entrada (cuyo nombre base debe coincidir con el nombre de los slots, ej. `system.txt`, `guidelines.txt`) contra el contrato.

```bash
npm run cli -- lint --contract path/to/contract.yaml --inputs path/to/inputs_dir --hashes path/to/expected_hashes.json
```
- Si hay infracciones con severidad `error`, la CLI imprime los hallazgos y termina con un código de salida `1` (ideal para CI/CD).
- Si solo hay advertencias o información, o el contrato es completamente válido, termina con `0`.

El conteo de tokens es enchufable: añade `--tokenizer gpt` a `lint`/`assemble` para usar tokens BPE reales (OpenAI) en lugar de la heurística por defecto.

### 2. Ensamblar Contexto (`assemble`)
Asigna los budgets de tokens por prioridad, corta/resume los slots según corresponda, ejecuta el linter, y emite el payload listo para inyectarse al LLM.

```bash
npm run cli -- assemble --contract path/to/contract.yaml --inputs path/to/inputs_dir --output path/to/assembled_output.txt --hashes path/to/expected_hashes.json
```
- Si la validación falla, **no escribe** el payload (evita persistir secretos/prompts manipulados) y termina con `1`.

### 2b. Firmar Hashes de Inmutabilidad (`hash`)
Genera (o actualiza) el archivo de hashes esperados a partir de los inputs, en vez de mantenerlo a mano. Por defecto firma solo los slots inmutables y los objetivos de reglas `immutable-hash`; con `--all` firma todos.

```bash
npm run cli -- hash --contract path/to/contract.yaml --inputs path/to/inputs_dir --output path/to/expected_hashes.json
```
- Sin `--output`, imprime el JSON por stdout. Si el archivo existe, fusiona preservando entradas manuales.
- Flujo típico: ejecutar `hash` al actualizar deliberadamente un prompt inmutable; luego `lint` detecta cualquier cambio no firmado.

### 3. Comparar Contratos y Detectar Regresiones (`diff`)
Compara semánticamente dos contratos (ej. rama actual vs rama principal en Git). Detecta cambios de tokens, slots eliminados, y **regresiones estructurales** como reducciones del budget total o degradación de prioridades de slots críticos.

```bash
npm run cli -- diff --old path/to/contract_v1.yaml --new path/to/contract_v2.yaml
```
- Retorna código de salida `1` si detecta regresiones de políticas de contexto.

---

## 📦 Integración como Librería (API Programática)

Puedes importar y usar el motor en tu backend de Node.js/TypeScript de forma sencilla:

```typescript
import { Engine } from './src/engine.js';
import yaml from 'js-yaml';
import fs from 'fs';

// 1. Cargar el contrato
const contractContent = yaml.load(fs.readFileSync('contract.yaml', 'utf8'));

// 2. Instanciar el motor
const engine = new Engine(contractContent);

// 3. Definir entradas dinámicas y del entorno recolectadas
const inputs = {
  system: "Instrucciones base del sistema...",
  guidelines: "Reglas de desarrollo...",
  user_message: "Por favor, analiza este código..."
};

// Hash original del system prompt estático inmutable (opcional, para auditorías de drift)
const expectedHashes = {
  system: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
};

// 4. Ensamblar y validar el payload
const result = engine.assemble(inputs, expectedHashes);

if (result.verdict.valid) {
  // El payload está limpio y verificado
  const prompt = result.content;
  console.log("Tokens totales utilizados:", result.metadata.totalTokens);
  
  // Llamar al LLM con `prompt`
} else {
  // Manejar errores de contrato (ej. credenciales detectadas o referencias rotas)
  console.error("Fallos de validación detectados:", result.verdict.findings);
}
```

---

## 🔍 Reglas de Linter Soportadas

1. **`regex`**: Evalúa una expresión regular sobre el contenido de un slot. Admite `negate: true` para fallar si el patrón coincide (útil para detectar leaks de secretos, lenguaje inapropiado, etc.) y `flags` opcional (ej. `"i"`, `"m"`, `"im"`) para controlar el matching. El flag global `g` se ignora deliberadamente para mantener el chequeo determinista.
2. **`broken-ref`**: Busca plantillas tipo `{nombre_de_slot}` en un texto. Alerta si se referencia un slot que no está declarado en la especificación.
3. **`schema`**: Si el formato del slot es `json`, valida la sintaxis y permite comprobar campos requeridos a través de JSON Schema simplificado.
4. **`immutable-hash`** & **`immutable-slot-drift`**: Compara la firma del slot estático contra una lista de hashes firmada. Si el prompt estático cambia sin actualizar la firma, lanza error de compilación.

### Reglas personalizadas

El motor despacha cada regla a un handler registrado por su `type`. Puedes registrar tipos de regla propios (o sobrescribir los built-in) al instanciar el `Engine`:

```typescript
const engine = new Engine(contract, {
  ruleHandlers: {
    'max-words': ({ rule, text }) => {
      const limit = Number(rule.pattern);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      return words > limit
        ? [{ severity: rule.severity, rule: rule.name, message: `Demasiadas palabras: ${words} > ${limit}`, slot: rule.targetSlot }]
        : [];
    }
  }
});
```

Un `type` sin handler registrado produce un hallazgo `warning` (`unknown-rule-type`) y se omite. Ver [docs/API.md](docs/API.md) para `RuleHandler`/`RuleContext`.

---

## 🧪 Ejecución de Pruebas

Para correr el set de pruebas automáticas:
```bash
npm test
```

## ⚠️ Limitaciones conocidas y Roadmap

Esta versión es funcional pero tiene atajos deliberados que conviene conocer antes de usarla en producción:

- **Conteo de tokens**: por defecto usa la heurística `1 token ≈ 4 caracteres`. Para presupuestos exactos, el tokenizador es **enchufable**: usa `--tokenizer gpt` en la CLI o inyecta `gptTokenizer` en el `Engine` para contar tokens BPE reales (OpenAI cl100k_base). El truncado respeta el presupuesto con cualquier tokenizador.
- **`compaction: "summarize"` no resume**: trunca y añade un marcador. *(Roadmap: estrategia de compactación enchufable, opcionalmente vía LLM.)*
- **`type: "schema"` es validación simplificada**: solo comprueba la presencia de claves de primer nivel listadas en `required`, no es JSON Schema completo. *(Roadmap: integrar `ajv`/Zod.)*
- **Referencias `{slot}`**: solo se *detectan* las rotas (`broken-ref`); no hay interpolación/sustitución de referencias válidas.
- **Reglas regex**: se ejecutan sobre contenido arbitrario sin protección contra ReDoS. Audita los patrones del contrato.

Ver el detalle normativo de cada comportamiento en [SPEC.md](SPEC.md).

## 🎬 Demo de Casos de Uso

Para ver el framework en acción sobre un agente de revisión de código en un pipeline de CI:
```bash
npm run demo
```
Ejecuta cuatro escenarios en orden y reporta su exit code:
1. **PR válido** → ensambla el payload (exit 0).
2. **Secreto hardcodeado en el diff** → bloqueado por la regla `no-secrets-allowed` (exit 1).
3. **System prompt inmutable manipulado** → bloqueado por drift de hash SHA-256 (exit 1).
4. **Guardia programática** (API del `Engine`) → rechaza el contexto sin llamar al LLM (exit 1).

Los fixtures viven en `example/` (`scenario-bad/`, `scenario-drift/`) y el ejemplo de integración programática en `example/demo-gate.ts`.
