import { initRepository } from '../core/repository.js';
import { installSampleHooks } from '../core/hooks.js';
import { success, error, info } from '../utils/display.js';

export function registerInit(program) {
  program
    .command('init')
    .description('Initialize a new Logit repository')
    .action(async () => {
      try {
        const logitDir = await initRepository();
        success(`Initialized empty Logit repository in ${logitDir}`);

        // Install sample hooks
        const installed = await installSampleHooks(logitDir);
        if (installed.length > 0) {
          info(`Installed sample hooks: ${installed.join(', ')}`);
        }
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
