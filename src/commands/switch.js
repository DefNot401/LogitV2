import { checkout } from '../core/checkout.js';
import { getLogitDir } from '../core/repository.js';
import { success, error } from '../utils/display.js';

export function registerSwitch(program) {
  program
    .command('switch')
    .description('Switch to a different branch')
    .argument('<branch>', 'Branch name to switch to')
    .action(async (branch) => {
      try {
        const logitDir = await getLogitDir();
        const result = await checkout(logitDir, branch);

        if (result.isBranch) {
          success(`Switched to branch '${result.target}'`);
        } else {
          error(`'${branch}' is not a branch name. Use 'logit checkout' for commit hashes.`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
