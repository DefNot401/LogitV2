import { createTag, listTags, deleteTag } from '../core/tags.js';
import { getLogitDir } from '../core/repository.js';
import { resolveHead } from '../core/refs.js';
import { readCommit } from '../core/commit.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';

export function registerTag(program) {
  program
    .command('tag [name]')
    .description('Create, list, or delete tags')
    .option('-d, --delete <name>', 'Delete a tag')
    .option('-c, --commit <hash>', 'Tag a specific commit instead of HEAD')
    .action(async (name, options) => {
      try {
        const logitDir = await getLogitDir();

        // Delete mode
        if (options.delete) {
          await deleteTag(logitDir, options.delete);
          success(`Deleted tag '${options.delete}'.`);
          return;
        }

        // List mode (no name given)
        if (!name) {
          const tags = await listTags(logitDir);
          if (tags.length === 0) {
            info('No tags found. Create one with:  logit tag <name>');
            return;
          }
          console.log(chalk.bold('\nTags:\n'));
          for (const tag of tags) {
            let commitInfo = '';
            try {
              const commit = await readCommit(logitDir, tag.hash);
              const date = new Date(commit.timestamp).toLocaleDateString();
              commitInfo = chalk.gray(` → ${tag.hash.substring(0, 7)}  ${commit.message}  (${date})`);
            } catch { /* ignore */ }
            console.log(`  ${chalk.yellow('⬡')} ${chalk.bold.cyan(tag.name)}${commitInfo}`);
          }
          console.log('');
          return;
        }

        // Create mode
        let commitHash = options.commit;
        if (!commitHash) {
          commitHash = await resolveHead(logitDir);
          if (!commitHash) {
            throw new Error('Cannot tag: no commits yet.');
          }
        }

        const tag = await createTag(logitDir, name, commitHash);
        success(`Created tag '${tag.name}' → ${tag.hash.substring(0, 7)}`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
