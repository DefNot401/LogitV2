import { createCommit } from '../core/commit.js';
import { getLogitDir } from '../core/repository.js';
import { success, error } from '../utils/display.js';

export function registerCommit(program) {
  program
    .command('commit')
    .description('Record changes to the repository')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('-a, --author <author>', 'Override author (format: "Name <email>")')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const commit = await createCommit(logitDir, options.message, options.author);
        success(`[${commit.hash.substring(0, 7)}] ${commit.message}`);
        if (options.author) {
          success(`Author: ${options.author}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
