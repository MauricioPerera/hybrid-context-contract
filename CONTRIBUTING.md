# Contribuir a Hybrid Context Contract

¡Gracias por tu interés! Esta guía resume cómo trabajar en el proyecto.

## Requisitos

- Node.js **>= 20** (se usa `node:test` nativo).
- npm.

## Puesta en marcha

```bash
npm install
npm run build      # compila TypeScript a dist/
npm test           # compila y corre la suite (node:test)
npm run demo       # ejecuta los 4 escenarios de CI como prueba ejecutable
```

Las dependencias de tokenizador (`gpt-tokenizer`) y JSON Schema (`ajv`) son **opcionales**; se instalan automáticamente pero el core funciona sin ellas.

## Estructura del proyecto

| Ruta | Contenido |
|------|-----------|
| `src/types.ts` | Esquemas Zod + tipos (`Tokenizer`, `RuleHandler`, `Compactor`, …). Fuente de verdad. |
| `src/engine.ts` | Motor: presupuesto, linter, ensamblado; built-ins de reglas/compactores/tokenizador. |
| `src/diff.ts` | Diff semántico de contratos y detección de regresiones. |
| `src/cli.ts` | CLI (`lint`, `assemble`, `diff`, `spec`, `hash`). |
| `src/adapters/` | Adaptadores opcionales (`gpt-tokenizer`, `ajv-schema`). |
| `tests/` | Suite con `node:test`. |
| `example/` | Contratos, fixtures, demo y ejemplos de integración. |
| `SPEC.md` | Especificación normativa (debe mantenerse fiel al código). |
| `docs/API.md` | Referencia de la API pública. |

## Cómo extender el framework

El motor se extiende por inyección, sin tocar el core:

- **Nueva regla** — implementa un `RuleHandler` y regístralo: `new Engine(contract, { ruleHandlers: { 'mi-tipo': handler } })`.
- **Nueva estrategia de compactación** — implementa un `Compactor`: `{ compactors: { 'mi-estrategia': compactor } }`.
- **Nuevo tokenizador** — implementa la interfaz `Tokenizer`: `{ tokenizer }`.

Si la extensión depende de una librería pesada, colócala en `src/adapters/` como dependencia **opcional** (sigue el patrón de `gpt-tokenizer`/`ajv-schema`) y expón una entrada en `exports` del `package.json`.

## Reglas de oro

1. **La SPEC es normativa.** Si cambias el comportamiento del motor, actualiza `SPEC.md` y `docs/API.md` en el mismo PR. El código y la spec no deben divergir.
2. **Todo cambio lleva test.** Usa `node:test` + `assert`. Cubre el camino feliz y los bordes.
3. **Determinismo.** El motor debe ser una función pura de (contrato, inputs, hashes); el único no-determinismo permitido es `metadata.timestamp`.
4. **Garantías de seguridad.** No rompas: presupuesto respetado bajo cualquier tokenizador/compactor, `assemble` no escribe payloads inválidos, mitigación ReDoS.
5. **Sin dependencias nuevas en el core.** Si hace falta una librería, que sea `optionalDependencies` + adaptador.

## Flujo de trabajo

1. Crea una rama desde `main`.
2. Haz tus cambios con tests y docs.
3. Asegúrate de que pasan: `npm test` **y** `npm run demo`.
4. Mensajes de commit estilo [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`…).
5. Abre un PR describiendo el qué y el porqué. CI (Node 20/22) debe estar en verde.

## Checklist de PR

- [ ] `npm test` en verde (incluye nuevos tests).
- [ ] `npm run demo` en verde.
- [ ] `SPEC.md` / `docs/API.md` actualizados si cambió el comportamiento.
- [ ] `CHANGELOG.md` actualizado para cambios visibles.
- [ ] Sin dependencias nuevas en el core (usa adaptadores opcionales).

## Código de conducta

Este proyecto se adhiere al [Código de Conducta](CODE_OF_CONDUCT.md). Al participar, se espera que lo respetes.
