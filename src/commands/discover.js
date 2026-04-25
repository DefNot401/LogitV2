import mdns from 'multicast-dns';
import { info, success, error } from '../utils/display.js';
import chalk from 'chalk';

const SERVICE_TYPE = '_logit._tcp.local';
const SCAN_TIMEOUT = 4000;

export function registerDiscover(program) {
  program
    .command('discover')
    .description('Find active Logit servers on the local network')
    .option('-t, --timeout <ms>', 'Scan duration in milliseconds', '4000')
    .action(async (options) => {
      const timeout = parseInt(options.timeout, 10);
      const discovered = new Map(); // name -> { host, port, addresses }

      info('Scanning for Logit servers on the local network...');
      console.log('');

      const mdnsInstance = mdns();

      // Listen for query responses (PTR, SRV, A records)
      mdnsInstance.on('response', (response) => {
        // Look for PTR records pointing to our service
        const ptrs = response.answers.filter(
          (a) => a.type === 'PTR' && a.name === SERVICE_TYPE
        );

        for (const ptr of ptrs) {
          const instanceName = ptr.data; // e.g. "My-Repo._logit._tcp.local"

          // Find matching SRV record
          const srv = response.additionals.find(
            (a) => a.type === 'SRV' && a.name === instanceName
          ) || response.answers.find(
            (a) => a.type === 'SRV' && a.name === instanceName
          );

          // Find matching A/AAAA record
          const aRecord = response.additionals.find(
            (a) => (a.type === 'A' || a.type === 'AAAA') && a.name === srv?.data?.target
          );

          if (srv) {
            const port = srv.data.port;
            const host = aRecord ? aRecord.data : srv.data.target.replace(/\.$/, '');
            // Extract a friendly name — strip the service suffix
            const friendly = instanceName
              .replace(`.${SERVICE_TYPE}`, '')
              .replace(`._logit._tcp.local`, '');

            if (!discovered.has(instanceName)) {
              discovered.set(instanceName, { name: friendly, host, port });
            }
          }
        }
      });

      // Send PTR query for our service type
      mdnsInstance.query({
        questions: [{ name: SERVICE_TYPE, type: 'PTR' }]
      });

      // Wait for responses then print results
      await new Promise((resolve) => setTimeout(resolve, timeout));
      mdnsInstance.destroy();

      console.log('');
      if (discovered.size === 0) {
        info('No Logit servers found on the local network.');
        info('Make sure the remote machine is running  logit serve');
      } else {
        success(`Found ${discovered.size} server(s):\n`);

        const header = `  ${'REPOSITORY'.padEnd(30)} ${'ADDRESS'.padEnd(22)} COMMANDS`;
        console.log(chalk.bold.underline(header));

        for (const { name, host, port } of discovered.values()) {
          const url = `http://${host}:${port}`;
          const repoName = name || '(unknown)';
          console.log(
            `  ${chalk.cyan(repoName.padEnd(30))} ${chalk.yellow(url.padEnd(22))} ` +
            chalk.gray(`logit clone ${url}`)
          );
        }

        console.log('');
        info('Copy any clone command above, or use:');
        console.log(
          chalk.white('  logit remote add <name> ') +
          chalk.yellow('<url above>')
        );
      }
    });
}
