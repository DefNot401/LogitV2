import { stashPush, stashPop, stashList, stashDrop } from '../core/stash.js';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

export function registerStash(program) {
  const stash = program
    .command('stash')
    .description('Stash uncommitted changes and restore them later')
    .option('-m, --message <msg>', 'Custom stash message')
    .action(async (options) => {
      // Default: push (save) current changes
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const msg = await stashPush(logitDir, repoRoot, options.message);
        success(`Saved working directory state: "${msg}"`);
        info('Use  logit stash pop  to restore.');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('pop')
    .description('Restore the most recently stashed changes')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const entry = await stashPop(logitDir, repoRoot);
        success(`Restored stash: "${entry.message}"`);

        const stagedFiles = Object.entries(entry.files)
          .filter(([, v]) => v.staged)
          .map(([k]) => k);
        const wtFiles = Object.entries(entry.files)
          .filter(([, v]) => !v.staged)
          .map(([k]) => k);

        if (stagedFiles.length > 0) {
          console.log(chalk.green('\nRestored to index (staged):'));
          stagedFiles.forEach((f) => console.log(`  ${chalk.green('+')} ${f}`));
        }
        if (wtFiles.length > 0) {
          console.log(chalk.yellow('\nRestored to working tree:'));
          wtFiles.forEach((f) => console.log(`  ${chalk.yellow('~')} ${f}`));
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('list')
    .description('Show all stashed entries')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const entries = await stashList(logitDir);
        if (entries.length === 0) {
          info('No stash entries.');
          return;
        }
        entries.forEach((entry, i) => {
          const date = new Date(entry.timestamp).toLocaleString();
          console.log(
            `${chalk.yellow(`stash@{${i}}`)}  ${chalk.gray(date)}  ${entry.message}`
          );
        });
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });

  stash
    .command('drop [index]')
    .description('Remove a stash entry (default: newest)')
    .action(async (indexStr) => {
      try {
        const logitDir = await getLogitDir();
        const idx = indexStr !== undefined ? parseInt(indexStr, 10) : 0;
        const dropped = await stashDrop(logitDir, idx);
        success(`Dropped stash@{${idx}}: "${dropped.message}"`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
