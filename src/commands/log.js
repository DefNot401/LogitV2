import { getCommitLog } from '../core/commit.js';
import { resolveHead, getCurrentBranch } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatCommit, error, info } from '../utils/display.js';

export function registerLog(program) {
  program
    .command('log')
    .description('Show commit history')
    .option('-n, --number <count>', 'Number of commits to show', '10')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const headHash = await resolveHead(logitDir);

        if (!headHash) {
          info('No commits yet.');
          return;
        }

        const currentBranch = await getCurrentBranch(logitDir);
        const maxCount = parseInt(options.number, 10);
        const commits = await getCommitLog(logitDir, headHash, maxCount);

        for (let i = 0; i < commits.length; i++) {
          const commit = commits[i];
          if (i === 0 && currentBranch) {
            commit.branch = currentBranch;
          }
          console.log(formatCommit(commit));
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
