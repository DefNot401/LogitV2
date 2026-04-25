import path from 'path';
import { addFiles } from '../core/index.js';
import { getRepoRoot } from '../core/repository.js';
import { getAllFiles } from '../utils/fs.js';
import { success, error, info } from '../utils/display.js';

export function registerAdd(program) {
  program
    .command('add')
    .description('Add file(s) to the staging area')
    .argument('<files...>', 'Files to add (use "." for all files)')
    .action(async (files) => {
      try {
        const root = await getRepoRoot();
        let filesToAdd = [];

        if (files.includes('.')) {
          // Add all files in the repo
          filesToAdd = await getAllFiles(root);
        } else {
          // Normalize paths to be relative to repo root
          filesToAdd = files.map(f => {
            const absPath = path.resolve(f);
            return path.relative(root, absPath).replace(/\\/g, '/');
          });
        }

        if (filesToAdd.length === 0) {
          info('No files to add.');
          return;
        }

        const added = await addFiles(filesToAdd);
        for (const file of added) {
          success(`Added: ${file}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
