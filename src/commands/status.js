import { getStatus } from '../core/status.js';
import { getCurrentBranch } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatStatus, heading, info, error } from '../utils/display.js';

export function registerStatus(program) {
  program
    .command('status')
    .description('Show the working tree status')
    .action(async () => {
      try {
        const logitDir = await getLogitDir();
        const branch = await getCurrentBranch(logitDir);

        if (branch) {
          heading(`On branch ${branch}`);
        } else {
          heading('HEAD detached');
        }

        console.log('');
        const status = await getStatus();
        console.log(formatStatus(status.staged, status.modified, status.untracked));

        if (status.deleted.length > 0) {
          console.log('Deleted files:');
          for (const file of status.deleted) {
            info(`  deleted: ${file}`);
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
