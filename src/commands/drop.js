import { getLogitDir } from '../core/repository.js';
import { dropCommit, readCommit } from '../core/commit.js';
import { success, error, info } from '../utils/display.js';
import chalk from 'chalk';
import readline from 'readline';

export function registerDrop(program) {
  program
    .command('drop <hash>')
    .description('Delete a commit and rewrite subsequent history')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (hash, options) => {
      try {
        const logitDir = await getLogitDir();

        // Read the commit to make sure it exists before prompting
        const commit = await readCommit(logitDir, hash);
        
        info(`You are about to delete commit:`);
        console.log(`  ${chalk.yellow(commit.hash.substring(0,7))} ${commit.message}`);
        console.log(chalk.red('\nWARNING: This will rewrite the history of all subsequent commits.'));

        if (!options.yes) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const answer = await new Promise((resolve) => {
            rl.question('Are you sure you want to proceed? (y/N) ', resolve);
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            info('Operation aborted.');
            return;
          }
        }

        await dropCommit(logitDir, hash);
        success(`Commit ${hash.substring(0,7)} successfully dropped.`);
        info('Note: If this branch was pushed, others may face conflicts.');
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
