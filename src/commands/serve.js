import { createServer } from '../server/server.js';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { installSampleHooks } from '../core/hooks.js';
import { success, info, error } from '../utils/display.js';
import chalk from 'chalk';
import os from 'os';

export function registerServe(program) {
  program
    .command('serve')
    .description('Start a server to share this repository on the local network')
    .option('-p, --port <port>', 'Port to listen on', '5000')
    .option('--token <token>', 'Require this token for write operations (env: LOGIT_TOKEN)')
    .option('--read-only', 'Reject all push/write operations')
    .option('--no-mdns', 'Disable mDNS/Bonjour advertisement')
    .action(async (options) => {
      try {
        const logitDir = await getLogitDir();
        const repoRoot = await getRepoRoot();
        const port = parseInt(options.port, 10);

        // Resolve token — CLI flag takes priority, then environment variable
        const token = options.token || process.env.LOGIT_TOKEN || null;
        const readOnly = !!options.readOnly;

        const app = createServer(logitDir, repoRoot, { token, readOnly });

        app.listen(port, '0.0.0.0', async () => {
          const repoName = repoRoot.split(/[\\/]/).pop();

          console.log('');
          console.log(
            chalk.bold.hex('#7C3AED')('  ◆ Logit Server') +
            chalk.gray(` — ${repoName}`)
          );
          console.log(chalk.gray('  ─────────────────────────────────────'));

          // Auth status
          if (readOnly) {
            console.log(`  ${chalk.yellow('⚠')}  Mode: ${chalk.yellow('read-only')} (push/write rejected)`);
          } else if (token) {
            console.log(`  ${chalk.green('🔒')} Mode: ${chalk.green('authenticated')} (token required for writes)`);
          } else {
            console.log(`  ${chalk.gray('○')}  Mode: ${chalk.white('open')} (no auth — anyone can push)`);
          }

          console.log('');
          console.log(`  ${chalk.bold('Web UI')}      ${chalk.cyan(`http://localhost:${port}`)}`);
          console.log(`  ${chalk.bold('Repository')} ${repoRoot}`);
          console.log('');
          console.log(chalk.bold('  Clone commands:'));

          // Show all network interfaces
          const interfaces = os.networkInterfaces();
          for (const [, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
              if (addr.family === 'IPv4' && !addr.internal) {
                console.log(chalk.gray(`    logit clone http://${addr.address}:${port}`));
              }
            }
          }
          console.log(chalk.gray(`    logit clone http://localhost:${port}`));
          console.log('');

          // Ensure sample hooks exist
          const installed = await installSampleHooks(logitDir);
          if (installed.length > 0) {
            info(`Installed sample hooks: ${installed.join(', ')}`);
          }

          // mDNS advertisement
          if (options.mdns !== false) {
            try {
              const { default: mdns } = await import('multicast-dns');
              const mdnsInstance = mdns();

              mdnsInstance.on('query', (query) => {
                const questions = query.questions || [];
                const isOurs = questions.some(
                  (q) => q.name === '_logit._tcp.local' && (q.type === 'PTR' || q.type === 'ANY')
                );
                if (!isOurs) return;

                const instanceName = `${repoName}._logit._tcp.local`;
                const hostname = `${os.hostname().replace(/\.$/, '')}.local`;

                mdnsInstance.respond({
                  answers: [
                    { name: '_logit._tcp.local', type: 'PTR', data: instanceName },
                    {
                      name: instanceName,
                      type: 'SRV',
                      data: { port, target: hostname, priority: 0, weight: 0 }
                    },
                    { name: instanceName, type: 'TXT', data: [`repo=${repoName}`, `v=1`] }
                  ],
                  additionals: (() => {
                    const ips = [];
                    for (const [, addrs] of Object.entries(os.networkInterfaces())) {
                      for (const addr of addrs) {
                        if (addr.family === 'IPv4' && !addr.internal) {
                          ips.push({ name: hostname, type: 'A', data: addr.address, ttl: 30 });
                        }
                      }
                    }
                    return ips;
                  })()
                });
              });

              process.on('SIGINT', () => {
                mdnsInstance.destroy();
                process.exit(0);
              });
              process.on('SIGTERM', () => {
                mdnsInstance.destroy();
                process.exit(0);
              });

              info('mDNS advertisement active — discoverable via  logit discover');
            } catch (e) {
              // mDNS optional — don't crash if it fails
              info(`mDNS unavailable: ${e.message}`);
            }
          }

          info('Press Ctrl+C to stop the server.');
        });
      } catch (err) {
        error(err.message);
        process.exit(1);
      }
    });
}
