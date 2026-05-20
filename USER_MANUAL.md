# Logit User Manual
### Version 2.0 — Distributed Version Control System

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Installation](#2-installation)
3. [Quick Start](#3-quick-start)
4. [Core Concepts](#4-core-concepts)
5. [Command Reference](#5-command-reference)
   - [init](#init) — Create a new repository
   - [config](#config) — Set your identity
   - [add](#add) — Stage files
   - [commit](#commit) — Save a snapshot
   - [status](#status) — Check the working tree
   - [diff](#diff) — View changes
   - [log](#log) — Browse history
   - [branch](#branch) — Manage branches
   - [switch](#switch) — Change branches
   - [checkout](#checkout) — Restore files or commits
   - [merge](#merge) — Combine branches
   - [stash](#stash) — Shelve changes temporarily
   - [tag](#tag) — Mark milestones
   - [reset](#reset) — Undo changes
6. [Networking & Collaboration](#6-networking--collaboration)
   - [serve](#serve) — Share your repository
   - [clone](#clone) — Copy a remote repository
   - [remote](#remote) — Manage remote connections
   - [push](#push) — Upload your commits
   - [pull](#pull) — Download remote commits
   - [discover](#discover) — Find peers on the LAN
   - [sync](#sync) — One-command bidirectional sync
7. [Web Explorer](#7-web-explorer)
8. [Hooks](#8-hooks)
9. [.logitignore](#9-logitignore)
10. [Common Workflows](#10-common-workflows)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Introduction

**Logit** is a distributed version control system built for local-network collaboration. It provides all the essential tools for tracking file changes, branching, merging, and sharing repositories — without requiring a cloud service or an internet connection.

**Key strengths:**
- **Zero internet required** — Sync with teammates over Wi-Fi or a local network.
- **Zero configuration** — Auto-discover peers using mDNS (no IP addresses to remember).
- **Familiar workflow** — Commands follow conventions similar to Git.
- **Built-in Web UI** — Browse history and diffs in any browser.

---

## 2. Installation

### Prerequisites
- [Node.js](https://nodejs.org) v18 or higher

### Install globally
```bash
npm install -g .
```
> Run this from the root of the LogitV2 project directory. After installation, the `logit` command is available anywhere.

### Verify installation
```bash
logit --version
# 2.0.0
```

---

## 3. Quick Start

```bash
# 1. Create a new project
mkdir my-project && cd my-project
logit init

# 2. Set your identity (first time only)
logit config user.name "Alice"
logit config user.email "alice@example.com"

# 3. Stage and commit your first files
logit add .
logit commit -m "Initial commit"

# 4. Check what changed
logit status
logit log
```

---

## 4. Core Concepts

### Repository
A Logit repository is a directory containing a hidden `.logit/` folder. This folder stores the entire project history, branch pointers, and configuration.

### Objects
Logit stores every file version as a compressed, content-addressed **blob** object, identified by a SHA-1 hash. Trees and commits are also stored as objects.

### Staging Area (Index)
The staging area is a buffer between your working directory and the repository. You explicitly choose which files to include in your next commit using `logit add`.

```
Working Directory ──add──▶ Staging Area ──commit──▶ Repository
```

### Branches
A branch is a named pointer to a specific commit. The default branch is `main`. `HEAD` always points to your currently active branch or commit.

### Distributed Model
Every clone is a **full copy** of the repository — not just the latest files, but the entire history. Any machine can be a server or a client.

---

## 5. Command Reference

---

### `init`
**Initialize a new Logit repository in the current directory.**

```bash
logit init
```

Creates a `.logit/` folder with the required structure. Sets the default branch to `main`.

---

### `config`
**Read or set repository configuration values.**

```bash
# Show all config
logit config --list

# Read a single value
logit config user.name

# Set a value
logit config user.name "Alice"
logit config user.email "alice@example.com"
```

Configuration is stored in `.logit/config` (JSON format). The `user.name` and `user.email` values are embedded into every commit you make.

| Key | Description | Default |
|-----|-------------|---------|
| `user.name` | Your display name | System username |
| `user.email` | Your email address | `user@logit.local` |

> **Tip:** Run `logit config --list` after `logit init` to verify your identity before your first commit.

---

### `add`
**Stage files for the next commit.**

```bash
# Stage specific files
logit add src/main.js README.md

# Stage everything in the current directory
logit add .
```

Files listed in `.logitignore` are automatically excluded when using `logit add .`.

---

### `commit`
**Save a snapshot of the staged files.**

```bash
logit commit -m "Your commit message"

# Override the author for this commit only
logit commit -m "Fix typo" --author "Bob <bob@example.com>"
```

| Option | Description |
|--------|-------------|
| `-m, --message <msg>` | **(Required)** Commit message |
| `-a, --author <str>` | Override author in `"Name <email>"` format |

> **Note:** You must have at least one staged file. If the staging area is empty, the commit is rejected with a helpful message.

If a `pre-commit` hook exists in `.logit/hooks/`, it runs first. A non-zero exit code cancels the commit.

---

### `status`
**Show which files are staged, modified, or untracked.**

```bash
logit status
```

**Output legend:**
- **Staged** (green) — Files added and ready to commit.
- **Modified** (yellow) — Tracked files changed since the last commit but not yet staged.
- **Untracked** (gray) — New files not yet known to Logit.
- **Deleted** (red) — Files that existed in the last commit but are missing from disk.

---

### `diff`
**Show changes between commits or between a commit and the working tree.**

```bash
# Working directory vs last commit (default)
logit diff

# Diff a specific file only
logit diff src/main.js

# Working directory vs a specific commit
logit diff HEAD
logit diff abc1234

# Compare any two commits
logit diff abc1234..def5678

# Compare HEAD to a previous commit
logit diff abc1234..HEAD
```

Output is a colorized unified diff:
- 🟢 Green lines (`+`) — additions
- 🔴 Red lines (`-`) — removals
- 🔵 Cyan lines (`@@`) — hunk headers

---

### `log`
**Browse the commit history.**

```bash
# Show the last 10 commits
logit log

# Show a specific number of commits
logit log -n 20

# Show an ASCII graph with branch labels
logit log --graph
```

**Graph mode example:**
```
  * 8c20910 (HEAD → main) added sync command
  │   └─ Alice  5/13/2026
  │
  * 9474085 initial commit
      └─ Alice  5/12/2026
```

| Option | Description |
|--------|-------------|
| `-n, --number <n>` | Number of commits to show (default: 10) |
| `--graph` | Render an ASCII graph with branch labels |

---

### `branch`
**List, create, or delete branches.**

```bash
# List all branches (current branch is marked with *)
logit branch

# Create a new branch
logit branch feature-login

# Delete a branch
logit branch -d old-feature
```

---

### `switch`
**Switch to a different branch.**

```bash
logit switch main
logit switch feature-login
```

> Switches `HEAD` to point to the named branch. Your working directory is updated to reflect that branch's latest commit.

---

### `checkout`
**Restore the working directory to a specific commit or branch.**

```bash
# Checkout a branch (same as switch)
logit checkout main

# Checkout a specific commit (enters detached HEAD state)
logit checkout abc1234
```

> In **detached HEAD** state, you can look around but new commits won't belong to any branch. Switch back to a branch before continuing your work.

---

### `merge`
**Merge another branch into your current branch.**

```bash
logit merge feature-login
```

Logit performs a **three-way merge**. If both branches modified the same lines, a conflict is reported:

```
CONFLICT: src/app.js
Auto-merge failed. Resolve conflicts manually.
```

**Resolving conflicts:**
1. Open the conflicted file. You will see markers:
   ```
   <<<<<<< ours
   const x = 1;
   =======
   const x = 2;
   >>>>>>> theirs
   ```
2. Edit the file to keep what you want and remove all the markers.
3. Stage the resolved file: `logit add src/app.js`
4. Commit the merge: `logit commit -m "Merge feature-login"`

---

### `stash`
**Temporarily save uncommitted changes and restore them later.**

```bash
# Save current changes to the stash
logit stash

# List all stashed changesets
logit stash list

# Apply the most recent stash and remove it from the list
logit stash pop

# Apply the most recent stash but keep it in the list
logit stash apply

# Drop (delete) a specific stash entry
logit stash drop stash@{0}
```

> **Use case:** You're in the middle of something but need to switch branches quickly. Stash your work, switch, do what you need, then pop your stash back.

---

### `tag`
**Create, list, or delete named tags to mark important commits (e.g., releases).**

```bash
# Create a tag at the current HEAD
logit tag v1.0.0

# List all tags
logit tag

# Create a tag at a specific commit
logit tag v0.9.0 abc1234

# Delete a tag
logit tag -d v0.9.0
```

---

### `reset`
**Undo the last commit or unstage files.**

```bash
# Unstage specific files (keep changes in working directory)
logit reset src/main.js

# Unstage ALL staged files
logit reset --head

# Undo the last commit, but keep changes staged (safe)
logit reset --soft

# Undo the last commit AND discard all changes (destructive)
logit reset --hard
```

| Mode | HEAD moves? | Staging area | Working directory |
|------|-------------|--------------|-------------------|
| `[files]` (unstage) | No | Files removed | Unchanged |
| `--head` | No | Cleared | Unchanged |
| `--soft` | Yes (to parent) | Changes re-staged | Unchanged |
| `--hard` | Yes (to parent) | Cleared | **Restored to parent commit** |

> ⚠️ **`--hard` is destructive.** Any uncommitted changes in your working directory will be permanently lost.

---

## 6. Networking & Collaboration

Logit's networking model is peer-to-peer over a local network. No cloud service is needed.

---

### `serve`
**Start a server to share your repository on the local network.**

```bash
logit serve

# Use a different port (default is 5000)
logit serve --port 8080

# Disable mDNS advertisement
logit serve --no-mdns
```

When running, the server:
- Exposes the repository over HTTP for `clone`, `pull`, and `push`.
- Advertises itself via mDNS so peers can discover it automatically.
- Serves the **Web Explorer** at `http://localhost:5000`.

> **Tip:** The server prints all the IP addresses and clone commands needed by your teammates.

---

### `clone`
**Copy a remote repository to your local machine.**

```bash
logit clone http://192.168.1.10:5000

# Clone into a specific directory
logit clone http://192.168.1.10:5000 my-project
```

Clone will:
1. Download all objects (with a live progress bar).
2. Set up all branches and refs.
3. Check out the `main` branch.
4. Automatically save the source as the `origin` remote.

---

### `remote`
**Manage saved remote server connections.**

```bash
# List all saved remotes
logit remote list

# Add a remote
logit remote add origin http://192.168.1.10:5000
logit remote add alice http://192.168.1.42:5000

# Remove a remote
logit remote remove alice
```

Remotes are saved names for server URLs, so you don't have to remember IP addresses.

---

### `push`
**Upload your local commits to a remote server.**

```bash
# Push to 'origin' (default)
logit push

# Push to a specific remote
logit push --remote alice

# Force push (bypasses safety check — use with caution)
logit push --force
```

**Fast-forward protection:** If the remote has commits your branch doesn't, the push is rejected to prevent overwriting someone else's work. Run `logit pull` first to merge their changes, then push again.

> ⚠️ `--force` skips this check and **overwrites the remote history**. Only use it if you know what you're doing.

If a `pre-push` hook exists in `.logit/hooks/`, it runs before the upload.

---

### `pull`
**Download and apply commits from a remote server.**

```bash
# Pull from 'origin' (default)
logit pull

# Pull from a specific remote
logit pull --remote alice

# Force pull without the dirty-directory warning
logit pull --force
```

**Dirty directory protection:** If your working directory has unsaved or unstaged changes, Logit warns you before overwriting anything and asks for confirmation. Use `logit stash` to save your work first, or `--force` to proceed anyway.

---

### `discover`
**Scan the local network for active Logit servers.**

```bash
logit discover

# Scan for longer (in milliseconds)
logit discover --timeout 8000
```

**Example output:**
```
  REPOSITORY                     ADDRESS                COMMANDS
  my-project                     http://192.168.1.10:5000  logit clone http://192.168.1.10:5000
  alice-api                      http://192.168.1.42:5000  logit clone http://192.168.1.42:5000
```

---

### `sync`
**One-command bidirectional sync — the "AirDrop for Code" feature.**

```bash
# Auto-discover a peer and sync (prompts before connecting)
logit sync

# Skip the confirmation prompt
logit sync --yes

# Connect directly to a known URL (skip discovery)
logit sync --url http://192.168.1.10:5000

# Adjust the discovery scan duration
logit sync --timeout 8000
```

`logit sync` performs these steps automatically:
1. 🔍 **Discover** — Scans the LAN via mDNS for Logit servers.
2. 🤝 **Handshake** — Asks you to confirm (or lets you pick from multiple peers).
3. ⬇️ **Pull** — Downloads commits the peer has that you don't.
4. 🛡️ **Conflict check** — If the pull created merge conflicts, the sync **stops** and tells you which files to fix. It will NOT push conflict-marked files.
5. ⬆️ **Push** — Uploads commits you have that the peer doesn't.

**Typical team workflow:**
```bash
# Alice's machine (she is the server)
logit serve

# Bob's machine (anywhere on the same Wi-Fi)
logit sync
# Found "my-project" at http://192.168.1.10:5000. Sync now? (Y/n) y
# ↓ Pulling...  Already up to date.
# ↑ Pushing...  Pushed 3 object(s).
# ✔ Sync complete!
```

> **Why use this vs. push/pull?** No remote setup needed. No IP addresses to copy. Works offline (LAN only). Perfect for hackathons, classrooms, or any situation without a central server.

---

## 7. Web Explorer

When `logit serve` is running, open a browser and go to:

```
http://localhost:5000
```

The Web Explorer provides:
- **Dashboard** — Repository name, branch, and recent activity.
- **Commit Graph** — Visual history of all commits.
- **File Tree** — Browse files at any commit with a collapsible tree.
- **Diff Viewer** — Click any commit to see exactly what changed, with syntax highlighting.
- **Branch Switcher** — Navigate across branches.
- **Commit Search** — Live search through commit messages.

Teammates on the same network can access your Web Explorer at your LAN IP address (shown in the `logit serve` output).

---

## 8. Hooks

Hooks are scripts that Logit runs automatically at key points in the workflow.

### Location
```
.logit/hooks/
  pre-commit      # runs before every commit
  pre-push        # runs before every push
```

### Creating a hook

Create a file with no extension in `.logit/hooks/`. Make it executable.

**Example `pre-commit` (Node.js linting check):**
```bash
#!/usr/bin/env node
import { execSync } from 'child_process';
try {
  execSync('npx eslint src/', { stdio: 'inherit' });
} catch {
  console.error('Linting failed. Commit aborted.');
  process.exit(1); // non-zero exit cancels the commit
}
```

### Rules
- If the hook exits with code `0` → operation proceeds.
- If the hook exits with any other code → operation is **cancelled**.
- Logit installs sample (non-blocking) hooks automatically on first `logit serve`.

---

## 9. .logitignore

The `.logitignore` file tells Logit which files and directories to skip when running `logit add .`.

### Format
Each line is a pattern. Lines starting with `#` are comments.

```
# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local

# OS files
.DS_Store
Thumbs.db

# Logit internal
.logit/
```

### Pattern rules
| Pattern | Matches |
|---------|---------|
| `node_modules/` | The directory and all its contents |
| `*.log` | Any file ending in `.log` |
| `build/` | The `build` directory |
| `.env` | Exactly the file named `.env` |

---

## 10. Common Workflows

### Starting a new project
```bash
mkdir my-app && cd my-app
logit init
logit config user.name "Alice"
logit config user.email "alice@example.com"
logit add .
logit commit -m "Initial commit"
```

### Daily development loop
```bash
# See what changed
logit status

# Stage your work
logit add src/feature.js tests/feature.test.js

# Review what you're about to commit
logit diff

# Commit
logit commit -m "Add login feature"

# View history
logit log --graph
```

### Feature branch workflow
```bash
# Create and switch to a new branch
logit branch feature-payment
logit switch feature-payment

# ... do your work ...
logit add .
logit commit -m "Implement payment flow"

# Merge back into main
logit switch main
logit merge feature-payment

# Clean up
logit branch -d feature-payment
```

### Sharing work with a teammate
```bash
# Person A — host the repo
logit serve

# Person B — clone it once
logit clone http://192.168.1.10:5000

# Person B — sync any time after that
logit sync
```

### Undoing mistakes
```bash
# Unstage a file you didn't mean to add
logit reset accidental-file.js

# Undo your last commit but keep the changes (to re-commit differently)
logit reset --soft

# Completely throw away your last commit and all its changes
logit reset --hard

# Temporarily set aside unfinished work to fix a bug
logit stash
logit switch main
# ... fix the bug, commit ...
logit switch feature-branch
logit stash pop
```

### Comparing versions
```bash
# What changed since the last commit?
logit diff

# What's different between two commits?
logit diff abc1234..def5678

# What did I change in this specific file compared to HEAD?
logit diff HEAD src/app.js
```

---

## 11. Troubleshooting

### `Not a Logit repository`
You are not inside a folder that has been initialized with `logit init`, or any of its parent directories.
```bash
cd /path/to/your/project
logit init
```

### `Nothing to commit`
No files have been staged. Run `logit add <files>` first.

### `Push rejected: non-fast-forward`
Someone else pushed to the server while you were working. Pull their changes first:
```bash
logit pull
# resolve any conflicts if needed
logit push
```

### `No Logit servers found on the local network`
- Make sure the host machine is running `logit serve`.
- Make sure both machines are on the **same Wi-Fi or LAN network**.
- Check for firewall rules blocking UDP port 5353 (mDNS) or TCP port 5000.
- Try increasing the scan timeout: `logit discover --timeout 8000`

### `Sync paused: unresolved merge conflicts`
After syncing, one or more files contain conflict markers (`<<<<<<<`).
1. Open each conflicted file listed.
2. Edit them to resolve the conflicts (remove `<<<<<<<`, `=======`, `>>>>>>>` markers).
3. Stage the resolved files: `logit add <file>`
4. Commit: `logit commit -m "Resolve merge conflict"`
5. Then push manually: `logit push`

### `Pulling will overwrite your changes`
You have uncommitted modifications. Choose one:
- **Option A (recommended):** `logit stash` → `logit pull` → `logit stash pop`
- **Option B:** `logit commit -m "WIP"` → `logit pull`
- **Option C (destructive):** `logit pull --force` ⚠️ (loses your local changes)

### `Cannot connect to http://...`
- Confirm the host is running `logit serve` on the correct port.
- Ping the host IP from your machine to confirm network connectivity.
- Check if the host's firewall is blocking the port (default: 5000).

---

*Logit v2.0 — Built with Node.js, Express, and multicast-dns*
