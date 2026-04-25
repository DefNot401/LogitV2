import { listBranches, createBranch, resolveHead, getCurrentBranch, deleteBranch } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatBranches, success, error } from '../utils/display.js';

export function registerBranch(program) {
  program
    .command('branch')
    .description('List, create, or delete branches')
    .argument('[name]', 'Branch name to create')
    .option('-d, --delete <name>', 'Delete a branch')
    .action(async (name, options) => {
      try {
        const logitDir = await getLogitDir();

        if (options.delete) {
          const current = await getCurrentBranch(logitDir);
          if (options.delete === current) {
            throw new Error(`Cannot delete the current branch '${options.delete}'.`);
          }
          await deleteBranch(logitDir, options.delete);
          success(`Deleted branch '${options.delete}'.`);
          return;
        }

        if (name) {
          // Create a new branch
          const headHash = await resolveHead(logitDir);
          if (!headHash) {
            throw new Error('Cannot create branch: no commits yet.');
          }
          await createBranch(logitDir, name, headHash);
          success(`Created branch '${name}' at ${headHash.substring(0, 7)}.`);
        } else {
          // List branches
          const branches = await listBranches(logitDir);
          const current = await getCurrentBranch(logitDir);

          if (branches.length === 0) {
            console.log('No branches yet. Make a commit first.');
          } else {
            console.log(formatBranches(branches, current));
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
