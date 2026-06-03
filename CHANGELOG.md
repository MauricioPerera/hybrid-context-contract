# Changelog

Todas las modificaciones notables de este proyecto se documentan aquí.
El formato sigue [Keep a Changelog](https://keepachangelog.com/) y el versionado [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Diff semántico** detecta más regresiones de política de contexto: `maxTokens` de slot reducido, slot que deja de ser `immutable`, `compaction` que pasa de `error` a una estrategia con pérdida, slot que deja de ser `required`, severidad de regla rebajada, y regla eliminada.
- **Interpolación de referencias** opt-in (`new Engine(contract, { interpolate: true })`): resuelve `{slot}` y `{slot.key}` antes de presupuestar (una pasada, cycle-safe); las referencias rotas quedan para la regla `broken-ref`.
- **Playground web** (`web/`): dashboard estático (Vite + TS) que ejecuta el motor en el navegador — editor de contrato e inputs, presupuesto con slider, selector de tokenizador (heurístico / GPT real bajo demanda), toggle de interpolación, linter y payload en vivo. Job de CI que verifica su build.
- **Demo desplegada** en GitHub Pages: <https://mauricioperera.github.io/hybrid-context-contract/> (workflow de deploy automático en cada push a `main`).
- **Playground — pulido de UX**: presets de escenarios (PR válido, fuga de secreto, compactación, interpolación), persistencia en `localStorage`, enlace compartible (estado codificado en la URL) y botón de copiar payload.
- **Playground — visor de diff**: pestaña para comparar dos contratos (base/nuevo) y ver cambios por campo (from→to) y regresiones resaltadas, usando el mismo `diffContracts` del motor.

## [1.0.0] - 2026-06-03

Primer release. Framework para definir, mezclar y validar **Contratos de Contexto Híbrido** con validación determinista para LLMs y sistemas de agentes.

### Added
- **Motor (`Engine`)**: presupuesto de tokens por prioridad, compactación, linter determinista y ensamblado del payload.
- **Tokenización enchufable**: interfaz `Tokenizer` con `heuristicTokenizer` (4 chars/token) por defecto y `truncateToTokens()` que respeta el presupuesto con cualquier tokenizador (búsqueda binaria *surrogate-safe*).
  - Adaptador opcional `gpt-tokenizer` (BPE real de OpenAI) en `adapters/gpt-tokenizer`.
- **Reglas extensibles**: registro de `RuleHandler` despachado por `type`. Built-ins: `regex`, `schema`, `immutable-hash`, `broken-ref`. Reglas personalizadas vía `{ ruleHandlers }`.
  - Adaptador opcional `ajv` (JSON Schema completo) en `adapters/ajv-schema`.
- **Compactación enchufable**: registro de `Compactor` por `slot.compaction`. Built-ins `truncate`/`summarize`; estrategias personalizadas vía `{ compactors }`.
- **CLI** (`hcc`): comandos `lint`, `assemble`, `diff`, `spec` y `hash` (genera/firma el archivo de hashes de inmutabilidad). Opción `--tokenizer heuristic|gpt`.
- **Diff semántico** de contratos con detección de regresiones de política.
- **Documentación**: `README.md`, especificación normativa `SPEC.md`, referencia de API `docs/API.md`.
- **Demo** (`npm run demo`): cuatro escenarios de CI como prueba ejecutable.
- **Tooling**: build TypeScript con emisión de tipos, tests (`node:test`), CI en Node 20/22, licencia MIT, `.gitignore`/`.gitattributes`.

### Security
- `assemble` **no escribe** el payload si la validación falla (evita persistir secretos/prompts manipulados).
- **Garantía de presupuesto** mantenida bajo cualquier tokenizador y compactor (el motor recorta resultados que excedan el límite).
- Firma SHA-256 de slots inmutables y detección de *drift* (prompt injection).
- **Mitigación ReDoS**: detección heurística de patrones con cuantificadores anidados (`unsafe-regex-pattern`) y evaluación de input acotada en longitud.

### Known limitations
- El tokenizador por defecto es una heurística; usa el adaptador `gpt-tokenizer` para conteos exactos.
- `summarize` built-in trunca con marcador (no resume); inyecta un compactor propio para resumen real.
- `schema` built-in es validación simplificada; usa el adaptador `ajv` para JSON Schema completo.
- La mitigación ReDoS es heurística (cubre la clase dominante, no garantiza el 100%).
- Las referencias `{slot}` se detectan pero no se interpolan.

[1.0.0]: https://github.com/MauricioPerera/hybrid-context-contract/releases/tag/v1.0.0
