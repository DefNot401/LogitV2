import chalk from 'chalk';

/**
 * Display utilities for formatted terminal output.
 */

export function success(message) {
  console.log(chalk.green('✓ ') + message);
}

export function error(message) {
  console.error(chalk.red('✗ ') + message);
}

export function warn(message) {
  console.log(chalk.yellow('⚠ ') + message);
}

export function info(message) {
  console.log(chalk.blue('ℹ ') + message);
}

export function heading(message) {
  console.log(chalk.bold.cyan(message));
}

/**
 * Format a commit for display in logit log.
 */
export function formatCommit(commit) {
  const lines = [];
  lines.push(chalk.yellow(`commit ${commit.hash}`));
  if (commit.branch) {
    lines.push(chalk.cyan(` (${commit.branch})`));
  }
  lines.push(`Author:  ${commit.author || 'Unknown'}`);
  lines.push(`Date:    ${new Date(commit.timestamp).toLocaleString()}`);
  lines.push('');
  lines.push(`    ${commit.message}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Format a branch list for display.
 */
export function formatBranches(branches, currentBranch) {
  return branches.map(b => {
    if (b === currentBranch) {
      return chalk.green(`* ${b}`);
    }
    return `  ${b}`;
  }).join('\n');
}

/**
 * Format file status for display.
 */
export function formatStatus(staged, modified, untracked) {
  const lines = [];

  if (staged.length > 0) {
    lines.push(chalk.bold('Changes to be committed:'));
    lines.push(chalk.gray('  (use "logit checkout" to unstage)'));
    lines.push('');
    for (const file of staged) {
      lines.push(chalk.green(`\tnew file:   ${file}`));
    }
    lines.push('');
  }

  if (modified.length > 0) {
    lines.push(chalk.bold('Changes not staged for commit:'));
    lines.push(chalk.gray('  (use "logit add" to update what will be committed)'));
    lines.push('');
    for (const file of modified) {
      lines.push(chalk.red(`\tmodified:   ${file}`));
    }
    lines.push('');
  }

  if (untracked.length > 0) {
    lines.push(chalk.bold('Untracked files:'));
    lines.push(chalk.gray('  (use "logit add <file>..." to include in what will be committed)'));
    lines.push('');
    for (const file of untracked) {
      lines.push(chalk.red(`\t${file}`));
    }
    lines.push('');
  }

  if (staged.length === 0 && modified.length === 0 && untracked.length === 0) {
    lines.push('nothing to commit, working tree clean');
  }

  return lines.join('\n');
}
