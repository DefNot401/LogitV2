import chalk from 'chalk';
import { getDiff } from '../core/diff.js';
import { error, info } from '../utils/display.js';

export function registerDiff(program) {
  program
    .command('diff')
    .description('Show changes between commits, commit and working tree, etc.')
    .argument('[files...]', 'Specific files to diff')
    .action(async (files) => {
      try {
        const diffs = await getDiff(files);

        if (diffs.length === 0) {
          info('No changes detected.');
          return;
        }

        for (const { file, patch } of diffs) {
          // Colorize the unified diff output
          const lines = patch.split('\n');
          for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              console.log(chalk.green(line));
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              console.log(chalk.red(line));
            } else if (line.startsWith('@@')) {
              console.log(chalk.cyan(line));
            } else {
              console.log(line);
            }
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
