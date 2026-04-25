import { merge } from '../core/merge.js';
import { getLogitDir } from '../core/repository.js';
import { success, warn, error } from '../utils/display.js';

export function registerMerge(program) {
  program
    .command('merge')
    .description('Merge a branch into the current branch')
    .argument('<branch>', 'Branch to merge')
    .action(async (branch) => {
      try {
        const logitDir = await getLogitDir();
        const result = await merge(logitDir, branch);

        switch (result.type) {
          case 'up-to-date':
            success(result.message);
            break;
          case 'fast-forward':
            success(result.message);
            break;
          case 'merge':
            success(result.message);
            break;
          case 'conflict':
            warn(result.message);
            break;
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
