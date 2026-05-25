#!/usr/bin/env node

import { Command } from 'commander';
import { registerInit } from '../src/commands/init.js';
import { registerAdd } from '../src/commands/add.js';
import { registerCommit } from '../src/commands/commit.js';
import { registerLog } from '../src/commands/log.js';
import { registerCheckout } from '../src/commands/checkout.js';
import { registerStatus } from '../src/commands/status.js';
import { registerDiff } from '../src/commands/diff.js';
import { registerBranch } from '../src/commands/branch.js';
import { registerSwitch } from '../src/commands/switch.js';
import { registerMerge } from '../src/commands/merge.js';
import { registerServe } from '../src/commands/serve.js';
import { registerClone } from '../src/commands/clone.js';
import { registerPush } from '../src/commands/push.js';
import { registerPull } from '../src/commands/pull.js';
import { registerRemote } from '../src/commands/remote.js';
import { registerDiscover } from '../src/commands/discover.js';
import { registerStash } from '../src/commands/stash.js';
import { registerTag } from '../src/commands/tag.js';
import { registerDrop } from '../src/commands/drop.js';

const program = new Command();

program
  .name('logit')
  .description('A lightweight distributed version control system')
  .version('2.0.0');

// Core VCS
registerInit(program);
registerAdd(program);
registerCommit(program);
registerLog(program);
registerCheckout(program);
registerStatus(program);
registerDiff(program);
registerBranch(program);
registerSwitch(program);
registerMerge(program);

// Extended VCS
registerStash(program);
registerTag(program);
registerDrop(program);

// Network
registerServe(program);
registerClone(program);
registerPush(program);
registerPull(program);
registerRemote(program);
registerDiscover(program);

program.parse(process.argv);
