#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { Engine, computeHash } from './engine.js';
import { diffContracts, formatDiffMarkdown } from './diff.js';
import { ContextContractSchema, ContextContract, Tokenizer } from './types.js';

/**
 * Resolves the tokenizer named on the CLI. `heuristic` (or unset) uses the engine
 * default; `gpt` lazily loads the optional gpt-tokenizer adapter.
 */
async function resolveTokenizer(name?: string): Promise<Tokenizer | undefined> {
  if (!name || name === 'heuristic') return undefined; // engine default
  if (name === 'gpt') {
    try {
      const mod = await import('./adapters/gpt-tokenizer.js');
      return mod.gptTokenizer;
    } catch {
      console.error(`Error: --tokenizer gpt requires the optional dependency 'gpt-tokenizer'. Install it with: npm i gpt-tokenizer`);
      process.exit(1);
    }
  }
  console.error(`Error: unknown tokenizer "${name}". Valid values: 'heuristic' (default) or 'gpt'.`);
  process.exit(1);
}

function printHelp() {
  console.log(`
Usage: node --experimental-strip-types src/cli.ts <command> [options]

Commands:
  lint        Validates input files against a contract and runs deterministic checks.
              Options:
                --contract <path>     Path to contract file (YAML or JSON)
                --inputs <dir>        Directory containing input files (named by slot, e.g. system.txt)
                --hashes <path>       (Optional) Path to JSON file containing expected SHA-256 hashes
                --tokenizer <name>    (Optional) 'heuristic' (default) or 'gpt' (real OpenAI BPE counts)

  assemble    Mixes inputs, applies budgets, runs checks, and writes final payload.
              Options:
                --contract <path>     Path to contract file
                --inputs <dir>        Directory containing input files
                --output <path>       Path to save the assembled output text file
                --hashes <path>       (Optional) Path to JSON file containing expected SHA-256 hashes
                --tokenizer <name>    (Optional) 'heuristic' (default) or 'gpt' (real OpenAI BPE counts)

  hash        Generates/updates the expected SHA-256 hashes file from inputs.
              By default signs only slots that need it (immutable slots and
              immutable-hash rule targets); use --all to sign every input slot.
              Options:
                --contract <path>     Path to contract file
                --inputs <dir>        Directory containing input files
                --output <path>       (Optional) Hashes JSON to write/update; prints to stdout if omitted
                --all                 Sign every slot present in inputs

  diff        Compares two contract definitions and reports modifications and regressions.
              Options:
                --old <path>          Path to the base/original contract file
                --new <path>          Path to the updated contract file
                --format <type>       Output format: 'markdown' (default) or 'json'

  spec        Prints the JSON representation of the parsed contract.
              Options:
                --contract <path>     Path to contract file
`);
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        result[key] = val;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

function readContract(filePath: string): ContextContract {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: Contract file not found at ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let parsed: any;
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    parsed = yaml.load(content);
  } else {
    parsed = JSON.parse(content);
  }

  const validated = ContextContractSchema.safeParse(parsed);
  if (!validated.success) {
    console.error(`Error: Contract configuration does not match the schema:`);
    console.error(JSON.stringify(validated.error.format(), null, 2));
    process.exit(1);
  }

  return validated.data;
}

function readInputsDir(dirPath: string): Record<string, string> {
  if (!fs.existsSync(dirPath)) {
    console.error(`Error: Inputs directory not found at ${dirPath}`);
    process.exit(1);
  }

  const inputs: Record<string, string> = {};
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isFile()) {
      inputs[base] = fs.readFileSync(fullPath, 'utf8');
    }
  }
  return inputs;
}

function readExpectedHashes(filePath?: string): Record<string, string> | undefined {
  if (!filePath) return undefined;
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: Expected hashes file not found at ${filePath}. Skipping hash checks.`);
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = parseArgs(args.slice(1));

  if (!command) {
    printHelp();
    process.exit(1);
  }

  switch (command) {
    case 'lint': {
      const contractPath = options.contract;
      const inputsDir = options.inputs;
      const hashesPath = options.hashes;

      if (!contractPath || !inputsDir) {
        console.error('Error: --contract and --inputs are required for "lint".');
        printHelp();
        process.exit(1);
      }

      const contract = readContract(contractPath);
      const inputs = readInputsDir(inputsDir);
      const hashes = readExpectedHashes(hashesPath);
      const tokenizer = await resolveTokenizer(options.tokenizer);

      const engine = new Engine(contract, { tokenizer });
      // Run dry assemble to capture all allocation and linter warnings/errors
      const result = engine.assemble(inputs, hashes);

      console.log(`\n=== Verification Results for "${contract.name}" (v${contract.version}) ===`);
      if (result.verdict.findings.length === 0) {
        console.log('✅ Contract is valid. No findings.');
      } else {
        for (const finding of result.verdict.findings) {
          const icon = finding.severity === 'error' ? '❌' : finding.severity === 'warning' ? '⚠️' : 'ℹ️';
          console.log(`${icon} [${finding.severity.toUpperCase()}] (${finding.rule}) in slot "${finding.slot || 'general'}": ${finding.message}`);
        }
      }

      console.log(`\nVerification: ${result.verdict.valid ? 'PASSED' : 'FAILED'}`);
      process.exit(result.verdict.valid ? 0 : 1);
    }

    case 'assemble': {
      const contractPath = options.contract;
      const inputsDir = options.inputs;
      const outputPath = options.output;
      const hashesPath = options.hashes;

      if (!contractPath || !inputsDir || !outputPath) {
        console.error('Error: --contract, --inputs, and --output are required for "assemble".');
        printHelp();
        process.exit(1);
      }

      const contract = readContract(contractPath);
      const inputs = readInputsDir(inputsDir);
      const hashes = readExpectedHashes(hashesPath);
      const tokenizer = await resolveTokenizer(options.tokenizer);

      const engine = new Engine(contract, { tokenizer });
      const result = engine.assemble(inputs, hashes);

      console.log(`\n=== Assembly Summary ===`);
      console.log(`Contract: ${contract.name} (v${contract.version})`);
      console.log(`Total Tokens: ${result.metadata.totalTokens} / ${contract.maxTotalTokens}`);
      console.log(`\nSlot Usage breakdown:`);
      for (const [name, usage] of Object.entries(result.metadata.slotUsage)) {
        console.log(`  - ${name}: ${usage.allocatedTokens} tokens (${usage.status.toUpperCase()})`);
      }

      // Refuse to write a payload that failed validation: it may contain leaked
      // secrets or a tampered prompt. The output file is only produced on a clean verdict.
      if (!result.verdict.valid) {
        console.error(`\n❌ Error: Assembly failed validation. Output was NOT written.`);
        for (const finding of result.verdict.findings) {
          if (finding.severity !== 'error') continue;
          console.error(`   - [ERROR] (${finding.rule}) in slot "${finding.slot || 'general'}": ${finding.message}`);
        }
        process.exit(1);
      }

      fs.writeFileSync(outputPath, result.content, 'utf8');
      console.log(`\nOutput written to: ${outputPath}`);
      process.exit(0);
    }

    case 'hash': {
      const contractPath = options.contract;
      const inputsDir = options.inputs;
      const outputPath = options.output;
      const all = options.all === 'true';

      if (!contractPath || !inputsDir) {
        console.error('Error: --contract and --inputs are required for "hash".');
        printHelp();
        process.exit(1);
      }

      const contract = readContract(contractPath);
      const inputs = readInputsDir(inputsDir);

      // Slots that the linter actually verifies against a signature:
      // immutable slots (implicit drift check) + immutable-hash rule targets.
      const needsSigning = new Set<string>();
      for (const slot of contract.slots) if (slot.immutable) needsSigning.add(slot.name);
      for (const rule of contract.rules) if (rule.type === 'immutable-hash') needsSigning.add(rule.targetSlot);

      const targets = all
        ? Object.keys(inputs)
        : contract.slots.map(s => s.name).filter(n => needsSigning.has(n));

      // Merge over any existing hashes file so manual entries are preserved.
      let hashes: Record<string, string> = {};
      if (outputPath && fs.existsSync(outputPath)) {
        try { hashes = JSON.parse(fs.readFileSync(outputPath, 'utf8')); } catch { hashes = {}; }
      }

      const signed: string[] = [];
      const missing: string[] = [];
      for (const name of targets) {
        const text = inputs[name];
        if (text === undefined || text === '') { missing.push(name); continue; }
        hashes[name] = computeHash(text);
        signed.push(name);
      }

      const json = JSON.stringify(hashes, null, 2) + '\n';
      if (outputPath) {
        fs.writeFileSync(outputPath, json, 'utf8');
        console.log(`\n=== Hash Summary ===`);
        console.log(`Contract: ${contract.name} (v${contract.version})`);
        console.log(`Signed ${signed.length} slot(s): ${signed.join(', ') || '(none)'}`);
        console.log(`Written to: ${outputPath}`);
      } else {
        process.stdout.write(json);
      }

      if (missing.length > 0) {
        console.warn(`\n⚠️  Warning: no input found for slot(s) to sign: ${missing.join(', ')}`);
      }
      if (!all && targets.length === 0) {
        console.warn(`\n⚠️  Warning: no immutable slots or immutable-hash rules in the contract. Use --all to sign every slot.`);
      }

      process.exit(0);
    }

    case 'diff': {
      const oldPath = options.old;
      const newPath = options.new;
      const format = options.format || 'markdown';

      if (!oldPath || !newPath) {
        console.error('Error: --old and --new are required for "diff".');
        printHelp();
        process.exit(1);
      }

      const oldContract = readContract(oldPath);
      const newContract = readContract(newPath);

      const diffResult = diffContracts(oldContract, newContract);

      if (format === 'json') {
        console.log(JSON.stringify(diffResult, null, 2));
      } else {
        console.log(formatDiffMarkdown(diffResult));
      }

      // Exit 1 if regressions were found, 0 otherwise
      process.exit(diffResult.regressions.length > 0 ? 1 : 0);
    }

    case 'spec': {
      const contractPath = options.contract;
      if (!contractPath) {
        console.error('Error: --contract is required for "spec".');
        printHelp();
        process.exit(1);
      }
      const contract = readContract(contractPath);
      console.log(JSON.stringify(contract, null, 2));
      process.exit(0);
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
