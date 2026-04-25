import path from 'path';
import fs from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { fileExists } from '../utils/fs.js';
import { warn } from '../utils/display.js';

const HOOKS_DIR = 'hooks';

/**
 * Run a hook script if it exists.
 * @param {string} logitDir - Path to .logit directory
 * @param {string} hookName - e.g. 'pre-commit', 'pre-push'
 * @param {string[]} args   - Arguments to pass to the hook script
 * @returns {Promise<{ ran: boolean, exitCode: number }>}
 * @throws Error if hook exits with non-zero (includes stdout/stderr in message)
 */
export async function runHook(logitDir, hookName, args = []) {
  const hookPath = path.join(logitDir, HOOKS_DIR, hookName);

  if (!(await fileExists(hookPath))) {
    return { ran: false, exitCode: 0 };
  }

  // Ensure the hook is executable on Unix systems
  try {
    await fs.chmod(hookPath, 0o755);
  } catch { /* ignore on Windows */ }

  const isWindows = process.platform === 'win32';
  const ext = path.extname(hookPath).toLowerCase();
  let isShellScript = false;
  let isNodeScript = ext === '.js' || ext === '.mjs' || ext === '.cjs';

  if (!isNodeScript) {
    try {
      const content = await fs.readFile(hookPath, 'utf-8');
      if (content.startsWith('#!/bin/sh') || content.startsWith('#!/bin/bash')) {
        isShellScript = true;
      } else if (content.startsWith('#!') && content.includes('node')) {
        isNodeScript = true;
      }
    } catch {
      // Ignore read errors
    }
  }

  return new Promise((resolve, reject) => {
    let proc;
    const spawnOptions = {
      cwd: path.dirname(logitDir),
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env }
    };

    if (isNodeScript) {
      proc = spawn(process.execPath, [hookPath, ...args], spawnOptions);
    } else if (isWindows) {
      if (isShellScript) {
        // Try to find 'sh' or 'bash' on Windows
        let shellCmd = 'sh';
        try {
          execSync('where sh', { stdio: 'ignore' });
        } catch {
          try {
            execSync('where bash', { stdio: 'ignore' });
            shellCmd = 'bash';
          } catch {
            shellCmd = null;
          }
        }

        if (shellCmd) {
          proc = spawn(shellCmd, [hookPath, ...args], { ...spawnOptions, shell: true });
        } else {
          warn(`Hook '${hookName}' is a shell script but 'sh' or 'bash' was not found. Skipping hook.`);
          return resolve({ ran: false, exitCode: 0 });
        }
      } else {
        // For other files (e.g. .bat, .exe, or no shebang), use cmd /c with extra quoting trick
        const command = `"${hookPath}" ${args.join(' ')}`.trim();
        proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
          ...spawnOptions,
          windowsVerbatimArguments: true
        });
      }
    } else {
      proc = spawn(hookPath, args, {
        cwd: path.dirname(logitDir),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env }
      });
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });

    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(
          new Error(
            `Hook '${hookName}' exited with code ${exitCode}. Aborting.\n` +
            (stderr ? stderr.trim() : stdout.trim())
          )
        );
      } else {
        resolve({ ran: true, exitCode: 0 });
      }
    });

    proc.on('error', (err) => {
      // If the script can't be executed, warn but don't block
      reject(new Error(`Failed to run hook '${hookName}': ${err.message}`));
    });
  });
}

/**
 * Install sample hook scripts in .logit/hooks/.
 */
export async function installSampleHooks(logitDir) {
  const hooksDir = path.join(logitDir, HOOKS_DIR);
  await fs.mkdir(hooksDir, { recursive: true });

  const samples = {
    'pre-commit': [
      '#!/usr/bin/env node',
      '// pre-commit hook — runs before every commit.',
      '// Exit with non-zero to abort the commit.',
      '// To use a shell script, rename this or start with #!/bin/sh',
      '',
      '// Example: reject commits with TODO in staged files',
      '/*',
      'const { execSync } = require("child_process");',
      'try {',
      '  const output = execSync("logit status").toString();',
      '  if (output.includes("TODO")) {',
      '    console.error("Error: Fix TODOs first!");',
      '    process.exit(1);',
      '  }',
      '} catch (e) {}',
      '*/',
      '',
      'process.exit(0);',
    ].join('\n'),

    'pre-push': [
      '#!/usr/bin/env node',
      '// pre-push hook — runs before pushing to a remote.',
      '// Exit with non-zero to abort the push.',
      '',
      '// Example: run tests before pushing',
      '/*',
      'const { execSync } = require("child_process");',
      'try {',
      '  execSync("npm test", { stdio: "inherit" });',
      '} catch (e) {',
      '  process.exit(1);',
      '}',
      '*/',
      '',
      'process.exit(0);',
    ].join('\n'),
  };

  const installed = [];
  for (const [name, content] of Object.entries(samples)) {
    const hookPath = path.join(hooksDir, name);
    if (!(await fileExists(hookPath))) {
      await fs.writeFile(hookPath, content);
      try { await fs.chmod(hookPath, 0o755); } catch { /* Windows */ }
      installed.push(name);
    }
  }
  return installed;
}

/**
 * List existing hooks.
 */
export async function listHooks(logitDir) {
  const hooksDir = path.join(logitDir, HOOKS_DIR);
  try {
    return await fs.readdir(hooksDir);
  } catch {
    return [];
  }
}
