import AjvImport from 'ajv';
import { RuleHandler, ValidationFinding } from '../types.js';

// Interop: depending on module resolution, ajv is exposed as the default export
// or as the module object itself. Normalize to the constructor.
const Ajv: any = (AjvImport as any)?.default ?? AjvImport;

/**
 * Full JSON Schema validation rule handler, backed by Ajv (draft-07+).
 *
 * Requires the optional dependency `ajv`. Register it as a custom rule type
 * (recommended: 'json-schema', to coexist with the built-in simplified 'schema'):
 *
 *   import { Engine } from 'hybrid-context-contract';
 *   import { createAjvSchemaHandler } from 'hybrid-context-contract/adapters/ajv-schema';
 *   const engine = new Engine(contract, {
 *     ruleHandlers: { 'json-schema': createAjvSchemaHandler() }
 *   });
 *
 * The rule's `schemaJson` field holds the JSON Schema (as a JSON string); it is
 * validated against the parsed content of `targetSlot`. Compiled validators are
 * cached by schema string.
 */
export function createAjvSchemaHandler(options?: Record<string, unknown>): RuleHandler {
  const ajv = new Ajv({ allErrors: true, ...(options || {}) });
  const cache = new Map<string, any>();

  return ({ rule, text }): ValidationFinding[] => {
    if (!text.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      return [{
        severity: 'error',
        rule: `${rule.name}-invalid-json`,
        message: `JSON syntax error in slot "${rule.targetSlot}": ${e.message}`,
        slot: rule.targetSlot
      }];
    }

    if (!rule.schemaJson) {
      return [{
        severity: 'warning',
        rule: 'invalid-rule-config',
        message: `json-schema rule "${rule.name}" misses schemaJson configuration.`,
        slot: rule.targetSlot
      }];
    }

    let validate = cache.get(rule.schemaJson);
    if (!validate) {
      let schema: unknown;
      try {
        schema = JSON.parse(rule.schemaJson);
      } catch (e: any) {
        return [{
          severity: 'error',
          rule: `${rule.name}-invalid-schema`,
          message: `Invalid JSON Schema in rule "${rule.name}": ${e.message}`,
          slot: rule.targetSlot
        }];
      }
      try {
        validate = ajv.compile(schema as object);
      } catch (e: any) {
        return [{
          severity: 'error',
          rule: `${rule.name}-invalid-schema`,
          message: `Could not compile JSON Schema in rule "${rule.name}": ${e.message}`,
          slot: rule.targetSlot
        }];
      }
      cache.set(rule.schemaJson, validate);
    }

    if (validate(parsed)) return [];

    return (validate.errors || []).map((err: any) => ({
      severity: rule.severity,
      rule: rule.name,
      message: `${rule.message ? rule.message + ' — ' : ''}JSON content in slot "${rule.targetSlot}" failed schema at "${err.instancePath || '/'}": ${err.message}`,
      slot: rule.targetSlot
    }));
  };
}

/** Ready-to-use handler with default Ajv options. */
export const ajvSchemaHandler: RuleHandler = createAjvSchemaHandler();
