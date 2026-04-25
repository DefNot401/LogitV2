import { checkout } from '../core/checkout.js';
import { getLogitDir } from '../core/repository.js';
import { success, warn, error } from '../utils/display.js';

export function registerCheckout(program) {
  program
    .command('checkout')
    .description('Restore working directory to a specific commit or branch')
    .argument('<ref>', 'Commit hash or branch name')
    .action(async (ref) => {
      try {
        const logitDir = await getLogitDir();
        const result = await checkout(logitDir, ref);

        if (result.isBranch) {
          success(`Switched to branch '${result.target}'`);
        } else {
          warn(`HEAD is now at ${result.commitHash.substring(0, 7)} (detached HEAD state)`);
        }
        success(`Restored ${result.filesRestored} file(s).`);
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
