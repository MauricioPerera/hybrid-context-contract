import { encode, decode } from 'gpt-tokenizer';
import { Tokenizer } from '../types.js';

/**
 * Tokenizer backed by `gpt-tokenizer` (OpenAI BPE, cl100k_base by default).
 *
 * Requires the optional dependency `gpt-tokenizer` to be installed. The core engine
 * does NOT depend on it; import this adapter only if you want real OpenAI-family
 * token counts:
 *
 *   import { Engine } from 'hybrid-context-contract';
 *   import { gptTokenizer } from 'hybrid-context-contract/adapters/gpt-tokenizer';
 *   const engine = new Engine(contract, { tokenizer: gptTokenizer });
 */
export const gptTokenizer: Tokenizer = {
  countTokens(text: string): number {
    return encode(text).length;
  },
  truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    const tokens = encode(text);
    if (tokens.length <= maxTokens) return text;
    return decode(tokens.slice(0, maxTokens));
  }
};
