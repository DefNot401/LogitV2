# Logit User Manual

Logit is a lightweight, distributed version control system built with Node.js. It provides Git-like core functionality (staging, commits, branching) with a focused emphasis on **local network (LAN) repository sharing**.

## Table of Contents
- [Getting Started](#getting-started)
- [Basic Workflow](#basic-workflow)
- [Branching & Merging](#branching--merging)
- [LAN Collaboration](#lan-collaboration)
- [Automation with Hooks](#automation-with-hooks)
- [Command Reference](#command-reference)

---

## Getting Started

### Prerequisites
- **Node.js**: Version 18.0.0 or higher.
- **NPM**: Standard package manager.

### Installation
To use the `logit` command globally on your system:
1. Clone the Logit repository or navigate to its directory.
2. Run the following command:
   ```bash
   npm link
   ```
This will register the `logit` command so you can run it from any folder.

### Initializing a Repository
To start tracking a project, navigate to your project root and run:
```bash
logit init
```
This creates a `.logit` directory in your project, where all versioning data is stored.

---

## Basic Workflow

### 1. Checking Status
See which files are modified, staged, or untracked:
```bash
logit status
```

### 2. Staging Changes
Stage specific files or all changes to prepare for a commit:
```bash
logit add file1.js path/to/file2.js
# Or stage everything
logit add .
```

### 3. Committing Changes
Save your staged changes to the history with a descriptive message:
```bash
logit commit -m "Add login functionality"
```

### 4. Viewing History
List the commits in your current branch:
```bash
logit log
# See only the last 5 commits
logit log -n 5
```

### 5. Inspecting Differences
See what has changed in your working files compared to the last commit:
```bash
logit diff
# For specific files
logit diff src/core/main.js
```

---

## Branching & Merging

### Creating & Listing Branches
List all branches (the current branch is marked with `*`):
```bash
logit branch
```
Create a new branch:
```bash
logit branch feature-xyz
```

### Switching Branches
Switch your working directory to another branch:
```bash
logit switch feature-xyz
```

### Merging Changes
Merge another branch's changes into your current branch:
```bash
logit merge feature-xyz
```
Logit supports **fast-forward** merges and creates **merge commits** for non-linear history.

---

## LAN Collaboration

Logit's standout feature is the ability to share repositories over your local network without needing a central server like GitHub. There is **no authentication** — anyone on the same network can clone, pull, and push freely (click-and-join).

### 1. Sharing Your Repository
To let others on your network clone and contribute to your code:
```bash
logit serve
```
By default, this starts a server on port **5000**. You can specify a different port:
```bash
logit serve --port 8080
```
The command will display:
- Your local IP addresses (e.g., `http://192.168.1.15:5000`) for others to use.
- A link to the built-in **Web Explorer UI** at `http://localhost:5000`.
- Ready-to-paste `logit clone` commands.

> [!TIP]
> The server runs in **open mode** — no tokens or passwords are needed. Anyone on the same WiFi or Ethernet can immediately clone, push, and pull.

### 2. Accessing a Shared Repository (Cloning)
If a colleague is running `logit serve`, simply run:
```bash
logit clone http://192.168.1.15:5000 [my-project-folder]
```
This initializes a local repository, fetches all objects, and checks out the current branch. It also automatically sets up a remote named `origin` pointing back to the host.

### 3. Managing Remotes
View your configured remote servers:
```bash
logit remote list
```
Add a new remote manually:
```bash
logit remote add colleague http://192.168.1.20:5000
```
Remove a remote:
```bash
logit remote remove colleague
```

### 4. Syncing Changes
**Pulling**: Get the latest updates from a remote branch:
```bash
logit pull origin main
```
**Pushing**: Send your local commits to a remote server:
```bash
logit push origin main
```

> [!TIP]
> Both the host and the client must be on the same WiFi or Ethernet network for these features to work.

---

## Automation with Hooks

Logit supports automated scripts that run at key points in the workflow. Hooks are stored in the `.logit/hooks/` directory.

### Supported Hooks
- **`pre-commit`**: Runs before every commit. If the script exits with a non-zero code, the commit is aborted.
- **`pre-push`**: Runs before pushing to a remote. If the script exits with a non-zero code, the push is aborted.

### Cross-Platform Hooks (Recommended)
For best compatibility across Windows, macOS, and Linux, it is recommended to write hooks using **Node.js**.

To create a Node.js hook, ensure the file starts with:
```javascript
#!/usr/bin/env node
```
Example `pre-commit` hook that prevents committing if "TODO" is found:
```javascript
#!/usr/bin/env node
const { execSync } = require('child_process');
const status = execSync('logit status').toString();

if (status.includes('TODO')) {
  console.error('Abort: You have TODOs in your files!');
  process.exit(1);
}
process.exit(0);
```

### Shell Hooks
You can also use standard shell scripts (starting with `#!/bin/sh`).
> [!IMPORTANT]
> **Windows Users**: Shell hooks require `sh` or `bash` to be in your PATH (e.g., from Git Bash). If these are not found, Logit will issue a warning and skip the hook instead of failing the operation.

---

## Command Reference

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `init` | | Initialize a new repo |
| `status` | | Show working tree status |
| `add` | `<files...>` | Stage files for commit |
| `commit` | `-m <message>` | Record staged changes |
| `log` | `[-n count]` | Show commit history |
| `diff` | `[files...]` | Show file differences |
| `branch` | `[name]` | List or create branches |
| `switch` | `<branch>` | Switch to a branch |
| `merge` | `<branch>` | Merge branch into current |
| `checkout` | `<ref>` | Restore files or switch HEAD |
| `serve` | `[-p port]` | Start LAN sharing server (open, no auth) |
| `clone` | `<url> [dir]` | Clone from a remote server |
| `remote` | `add/list/remove` | Manage remotes |
| `push` | `[-r remote]` | Send commits to remote |
| `pull` | `[-r remote]` | Fetch and merge from remote |
