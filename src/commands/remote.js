import path from 'path';
import fs from 'fs/promises';
import { getLogitDir } from '../core/repository.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

/**
 * Helper — read remotes file.
 */
async function readRemotes(logitDir) {
  const remotesPath = path.join(logitDir, 'remotes');
  try {
    const content = await fs.readFile(remotesPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeRemotes(logitDir, remotes) {
  const remotesPath = path.join(logitDir, 'remotes');
  await fs.writeFile(remotesPath, JSON.stringify(remotes, null, 2));
}

export function registerRemote(program) {
  const remote = program
    .command('remote')
    .description('Manage remote server connections');

  // ── add ──────────────────────────────────────────────────────────────────
  remote
    .command('add')
    .description('Add a new remote')
    .argument('<name>', 'Remote name (e.g., origin)')
    .argument('<url>', 'Server URL (e.g., http://192.168.1.10:5000)')
    .action(async (name, url) => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);

        if (remotes[name]) {
          throw new Error(`Remote '${name}' already exists. Use 'logit remote remove ${name}' first.`);
        }

        const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        remotes[name] = cleanUrl;

        await writeRemotes(logitDir, remotes);
        success(`Added remote '${name}' → ${cleanUrl}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── remove ────────────────────────────────────────────────────────────────
  remote
    .command('remove')
    .description('Remove a remote')
    .argument('<name>', 'Remote name to remove')
    .action(async (name) => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);

        if (!remotes[name]) throw new Error(`Remote '${name}' not found.`);

        delete remotes[name];
        await writeRemotes(logitDir, remotes);
        success(`Removed remote '${name}'.`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────────
  remote
    .command('list')
    .description('List all configured remotes')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const remotes = await readRemotes(logitDir);
        const entries = Object.entries(remotes);

        if (entries.length === 0) {
          info('No remotes configured.');
          return;
        }

        console.log(chalk.bold('\nRemotes:\n'));
        for (const [name, entry] of entries) {
          const url = typeof entry === 'string' ? entry : entry.url;
          console.log(`  ${chalk.cyan(name.padEnd(16))} ${chalk.yellow(url)}`);
        }
        console.log('');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

}
