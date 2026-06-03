# Hybrid Context Contract como *Harness* de Contexto

Este documento define **qué es** el proyecto desde su idea central: un **harness de contexto determinista** para modelos de lenguaje y sistemas de agentes.

---

## ¿Qué es un harness?

En sistemas de agentes, el **harness** es la capa de código **determinista** que envuelve, alimenta y restringe a un modelo **no determinista**. Es todo lo que rodea a la llamada de inferencia: cómo se reúne el contexto, cómo se valida, cómo se presupuesta y cómo se gobierna lo que entra (y, en general, lo que sale) del modelo.

El modelo es el único componente estocástico. El harness es —por diseño— **puro, testeable y reproducible**.

## Tesis del proyecto

> **Hybrid Context Contract es un harness de contexto.** Trata el prompt/contexto como un artefacto **estructurado, versionado y validado**, y garantiza que todo lo que entra al modelo sea determinista, de modo que **la única fuente de no-determinismo del sistema sea la inferencia interna del modelo**.

No es un framework de prompting ni un orquestador de agentes: es la **frontera de control** entre tu código determinista y la caja negra probabilística.

## La frontera determinista

```
   ┌─────────────────────── HARNESS (determinista) ───────────────────────┐
   │                                                                       │
inputs ──▶ slots ──▶ presupuesto ──▶ compactación ──▶ linter ──▶ payload   │ ──▶  MODELO  ──▶ salida
(static/  (orden/    (token         (truncate/        (reglas    validado  │   (inferencia,
 dynamic/  prioridad) budgeting)     summarize/        + firmas)            │    no determinista)
 state/env)                          custom)                               │
   │                                                                       │
   └───────────────────────────────────────────────────────────────────────┘
          payload = función pura de (contrato, inputs, hashes)
```

Todo lo que está a la izquierda del modelo es una **función pura** de `(contrato, inputs, hashes)`. El único campo no determinista del lado del harness es `metadata.timestamp`. El comportamiento normativo de cada etapa está en [SPEC.md](SPEC.md).

## Qué garantiza el harness

| Responsabilidad | Mecanismo |
|-----------------|-----------|
| **Estructura** | Slots tipados con origen, orden y prioridad. |
| **Presupuesto** | Token budgeting por prioridad; cabe en la ventana del modelo (tokenizador real enchufable). |
| **Integridad** | Firmas SHA-256 de slots inmutables; detección de *drift* / *prompt injection*. |
| **Seguridad de entrada** | Linter determinista (secretos, PII, referencias, JSON Schema); mitigación ReDoS; `assemble` no persiste payloads inválidos. |
| **Reproducibilidad** | Mismo input → mismo payload y mismo veredicto. |
| **Evolución segura** | Diff semántico de contratos + detección de regresiones de política en CI. |

## Qué **no** hace el harness (frontera explícita)

- **No ejecuta** la inferencia ni elige el modelo (eso lo decides tú; ver el adaptador de ejemplo).
- **No interpreta** ni valida la *salida* del modelo (su dominio es el contexto de **entrada**).
- **No garantiza correctitud semántica** del contenido — solo los **invariantes deterministas** declarados en el contrato.

## Ciclo de vida del harness

1. **Definir** el contrato (`CONTEXT.yaml`): slots, presupuesto, reglas.
2. **Recolectar** los inputs por slot (estáticos, dinámicos, de estado, de entorno).
3. **Ensamblar** (`assemble`): presupuestar → compactar → validar.
4. **Gate determinista**: si el veredicto es inválido, **abortar** — no se llama al modelo.
5. **Entregar** el payload validado al modelo.
6. **(CI)** comparar contratos (`diff`) para frenar regresiones antes de mergear.

## Puntos de extensión del harness

El harness es **agnóstico** y se extiende por inyección, sin tocar el núcleo:

- **Tokenizador** — `{ tokenizer }` (heurístico por defecto; adaptador `gpt-tokenizer` para conteo real).
- **Reglas** — `{ ruleHandlers }` (built-ins + personalizadas; adaptador `ajv` para JSON Schema completo).
- **Compactación** — `{ compactors }` (`truncate`/`summarize` + estrategias propias, p. ej. resumen vía LLM).

## Cómo se usa como harness

- **En CI** (frontera de equipo): el binario `hcc` (`lint`/`assemble`/`diff`/`hash`) corta el merge si el contexto viola el contrato.
- **En runtime** (frontera de proceso): la API `Engine.assemble()` como guardia antes de cada llamada al modelo. Ver [example/llm-anthropic.ts](example/llm-anthropic.ts) y [example/demo-gate.ts](example/demo-gate.ts).

---

> En una frase: **el harness hace determinista todo lo que se puede hacer determinista, para que solo quede una incógnita — el modelo.**
