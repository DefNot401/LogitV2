import chalk from 'chalk';
import { getCommitLog } from '../core/commit.js';
import { resolveHead, getCurrentBranch, getAllRefs } from '../core/refs.js';
import { getLogitDir } from '../core/repository.js';
import { formatCommit, error, info } from '../utils/display.js';

// ─── ASCII Graph helpers ──────────────────────────────────────────────────────

/**
 * Builds a simple linear/merge ASCII graph for the commit list.
 * Each commit shows: * <hash> (<branch>) <message> — <author> — <date>
 */
function buildGraph(commits, currentBranch, allRefs) {
  // Build a reverse map: hash -> branch names
  const hashToBranches = new Map();
  for (const [ref, hash] of Object.entries(allRefs)) {
    const branch = ref.replace('refs/heads/', '');
    if (!hashToBranches.has(hash)) hashToBranches.set(hash, []);
    hashToBranches.get(hash).push(branch);
  }

  const lines = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const isLast = i === commits.length - 1;

    // Branch label(s) for this commit
    const branches = hashToBranches.get(commit.hash) || [];
    const branchLabels = branches.map((b) => {
      const isHead = b === currentBranch;
      return isHead
        ? chalk.bold.cyan(`HEAD → ${b}`)
        : chalk.yellow(b);
    });

    const label = branchLabels.length > 0 ? ` (${branchLabels.join(', ')})` : '';
    const hash  = chalk.yellow(commit.hash.substring(0, 7));
    const msg   = chalk.white(commit.message);
    const author = chalk.gray(commit.author?.split('<')[0].trim() || 'Unknown');
    const date  = commit.timestamp
      ? chalk.gray(new Date(commit.timestamp).toLocaleDateString())
      : '';

    // Graph column
    const connector = isLast ? ' ' : chalk.gray('│');
    const node      = chalk.bold.magenta('*');

    lines.push(`${node} ${hash}${label} ${msg}`);
    lines.push(`${connector}   ${chalk.gray('└─')} ${author} ${date}`);
    if (!isLast) lines.push(chalk.gray('│'));
  }

  return lines;
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function registerLog(program) {
  program
    .command('log')
    .description('Show commit history')
    .option('-n, --number <count>', 'Number of commits to show', '10')
    .option('--graph', 'Show an ASCII graph of the commit history')
    .action(async (options) => {
      try {
        const logitDir   = await getLogitDir();
        const headHash   = await resolveHead(logitDir);

        if (!headHash) {
          info('No commits yet.');
          return;
        }

        const currentBranch = await getCurrentBranch(logitDir);
        const maxCount      = parseInt(options.number, 10);
        const commits       = await getCommitLog(logitDir, headHash, maxCount);

        if (options.graph) {
          const allRefs = await getAllRefs(logitDir);
          console.log('');
          const graphLines = buildGraph(commits, currentBranch, allRefs);
          for (const line of graphLines) {
            console.log('  ' + line);
          }
          console.log('');
        } else {
          for (let i = 0; i < commits.length; i++) {
            const commit = commits[i];
            if (i === 0 && currentBranch) {
              commit.branch = currentBranch;
            }
            console.log(formatCommit(commit));
          }
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
