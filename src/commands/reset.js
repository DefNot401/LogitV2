import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { resolveHead, updateHead, getCurrentBranch } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { readObject } from '../core/objects.js';
import { getIndex, clearIndex } from '../core/index.js';
import { ensureDir } from '../utils/fs.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';

export function registerReset(program) {
  program
    .command('reset')
    .description('Undo the last commit or unstage files')
    .argument('[files...]', 'Files to unstage (leave empty to undo last commit)')
    .option('--soft', 'Undo last commit but keep changes staged')
    .option('--hard', 'Undo last commit AND discard all working directory changes')
    .option('--head', 'Reset to HEAD (unstage all staged changes)')
    .action(async (files, options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();

        // ── Unstage specific files ────────────────────────────────────────
        if (files && files.length > 0) {
          const indexPath = path.join(logitDir, 'index');
          const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

          let unstaged = 0;
          for (const file of files) {
            const normalized = file.replace(/\\/g, '/');
            if (index.entries[normalized]) {
              delete index.entries[normalized];
              unstaged++;
              info(`Unstaged: ${chalk.yellow(normalized)}`);
            } else {
              info(`Not staged: ${chalk.gray(normalized)}`);
            }
          }
          await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
          if (unstaged > 0) success(`Unstaged ${unstaged} file(s).`);
          return;
        }

        // ── Reset HEAD (unstage everything) ───────────────────────────────
        if (options.head) {
          await clearIndex(logitDir);
          success('Unstaged all changes (index cleared to match HEAD).');
          return;
        }

        // ── Undo last commit (--soft or --hard) ───────────────────────────
        const headHash = await resolveHead(logitDir);
        if (!headHash) {
          throw new Error('No commits to reset. The repository has no history.');
        }

        const headCommit = await readCommit(logitDir, headHash);
        const parentHash = headCommit.parent;

        if (!parentHash) {
          throw new Error(
            'Cannot reset: this is the very first commit. ' +
            'Use "logit reset --head" to just unstage files.'
          );
        }

        // Move HEAD back to parent
        await updateHead(logitDir, parentHash);
        info(`HEAD moved back to ${chalk.yellow(parentHash.substring(0, 7))}`);

        if (options.hard) {
          // Restore working directory to the parent commit's tree
          const parentCommit = await readCommit(logitDir, parentHash);
          const treeEntries = await readTree(logitDir, parentCommit.tree);

          for (const entry of treeEntries) {
            const obj = await readObject(logitDir, entry.hash);
            const filePath = path.join(repoRoot, entry.name);
            await ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, obj.content);
          }

          // Clear index too
          await clearIndex(logitDir);
          success(
            `Hard reset to ${chalk.yellow(parentHash.substring(0, 7))}: ` +
            chalk.gray('working directory and staging area restored.')
          );
        } else {
          // --soft (default): keep changes staged
          // Re-stage the files from the undone commit so they appear staged
          const undoneTree = await readTree(logitDir, headCommit.tree);
          const indexPath = path.join(logitDir, 'index');
          const index = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

          for (const entry of undoneTree) {
            index.entries[entry.name] = { hash: entry.hash };
          }
          await fs.writeFile(indexPath, JSON.stringify(index, null, 2));

          success(
            `Soft reset to ${chalk.yellow(parentHash.substring(0, 7))}: ` +
            chalk.gray(`changes from the undone commit are now staged.`)
          );
          info(`Tip: use ${chalk.cyan('logit status')} to see what is staged.`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
