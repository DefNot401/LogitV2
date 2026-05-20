import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

/**
 * Reads config from .logit/config, writes back with updated key.
 * Supports dot-notation keys like "user.name" or "user.email".
 */
async function readConfig(logitDir) {
  const configPath = path.join(logitDir, 'config');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {
    return { user: { name: 'Unknown', email: 'user@logit.local' } };
  }
}

async function writeConfig(logitDir, config) {
  const configPath = path.join(logitDir, 'config');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

function getNestedValue(obj, keys) {
  return keys.reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function setNestedValue(obj, keys, value) {
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

function flattenConfig(obj, prefix = '') {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) {
      lines.push(...flattenConfig(v, fullKey));
    } else {
      lines.push({ key: fullKey, value: v });
    }
  }
  return lines;
}

export function registerConfig(program) {
  program
    .command('config')
    .description('Get or set repository configuration values')
    .argument('[key]', 'Config key in dot notation (e.g. user.name)')
    .argument('[value]', 'Value to set (omit to read the current value)')
    .option('-l, --list', 'List all configuration values')
    .action(async (key, value, options) => {
      try {
        const logitDir = await getLogitDir();
        const config = await readConfig(logitDir);

        // ── List all config ───────────────────────────────────────────────
        if (options.list || (!key && !value)) {
          console.log('');
          console.log(chalk.bold('  Repository Configuration'));
          console.log(chalk.gray('  ─────────────────────────────────────'));
          const pairs = flattenConfig(config);
          for (const { key: k, value: v } of pairs) {
            console.log(`  ${chalk.cyan(k.padEnd(24))} ${chalk.white(v)}`);
          }
          console.log('');
          return;
        }

        const keys = key.split('.');

        // ── Read a single key ─────────────────────────────────────────────
        if (value === undefined) {
          const result = getNestedValue(config, [...keys]);
          if (result === undefined) {
            error(`Config key '${key}' not found.`);
            process.exit(1);
          }
          console.log(result);
          return;
        }

        // ── Set a key ─────────────────────────────────────────────────────
        setNestedValue(config, keys, value);
        await writeConfig(logitDir, config);
        success(`Set ${chalk.cyan(key)} = ${chalk.white(value)}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
