# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is the Claude Code Runner project - a CLI tool that runs Claude Code instances inside isolated Docker containers with automatic git integration. The tool creates safe sandboxed environments where Claude can execute commands and make code changes without affecting the host system.

## Common Development Commands

### Build and Development

- `npm run build` - Compile TypeScript to JavaScript (output in `dist/`)
- `npm run dev` - Watch mode for TypeScript compilation
- `npm run link` - Remove global install, rebuild, and link for local development
- `npm start` - Build and run the CLI tool
- `npm run lint` - Run ESLint
- `npm run fix` - Run ESLint and fix formatting errors

### Container Management

- `npm run purge-containers` - Remove all Claude Runner containers and images
- `claude-run list` - List all running Claude Runner containers
- `claude-run stop --all` - Stop all running containers
- `claude-run clean -f` - Remove all containers (including running)

### Testing the CLI Locally

When developing, use `npm run link` to create a global `claude-run` command that points to your local development version.

## Architecture

### Core Components

1. **CLI Entry Point** (`src/cli.ts`)
   - Command-line interface using Commander.js
   - Handles all CLI commands (start, attach, list, stop, logs, clean, purge, config, self-update)
   - Manages Docker/Podman initialization and configuration
   - Non-blocking update checker on startup

2. **Main Sandbox Orchestrator** (`src/index.ts`)
   - Orchestrates the entire container lifecycle
   - Manages git branch creation and switching
   - Handles web UI server lifecycle
   - Coordinates between container, git, and web UI

3. **Container Management** (`src/container.ts`)
   - Docker container lifecycle management using dockerode
   - Builds images, creates containers, handles streams
   - Manages volume mounts for credentials and workspace
   - Handles both Docker and Podman via runtime detection

4. **Web UI Server** (`src/web-server.ts`)
   - Express server with Socket.io for real-time terminal streaming
   - Manages multiple concurrent sessions with reconnection support
   - Real-time file monitoring using inotify in containers
   - Handles git operations (commit, push, PR info) via web UI
   - Maintains shadow repository sync for each container

5. **Shadow Repository System** (`src/git/shadow-repository.ts`)
   - Creates temporary git clones for each container session
   - Syncs files from container to host using rsync (with fallback to docker cp)
   - Tracks git changes without affecting original repository
   - Handles git-tracked files vs gitignore patterns intelligently
   - Supports branch switching and remote branch tracking

6. **Git Integration** (`src/git-monitor.ts`)
   - Monitors git repository for new commits
   - Uses simple-git for operations
   - Provides real-time notifications of Claude's commits

7. **Credential Discovery** (`src/credentials.ts`)
   - Automatically discovers Claude API keys (Anthropic, AWS Bedrock, Google Vertex)
   - Discovers GitHub credentials (CLI auth, SSH keys)
   - Mounts credentials read-only into containers

8. **Configuration** (`src/config.ts`)
   - Loads and validates configuration from `claude-run.config.json`
   - Manages Docker settings, environment variables, and Claude parameters
   - Handles default values and environment variable expansion

9. **Docker/Podman Configuration** (`src/docker-config.ts`)
   - Auto-detects Docker vs Podman
   - Handles socket path detection across different platforms
   - Provides unified interface for both runtimes

10. **UI Components** (`src/ui.ts`)
    - Interactive prompts using inquirer
    - Diff display with syntax highlighting
    - Commit review interface

### Key Design Decisions

- **Containerized Isolation**: Claude runs with `--dangerously-skip-permissions` flag (safe within container isolation)
- **Git Branch Safety**: Git wrapper prevents branch switching to protect main branch
- **Read-only Credentials**: All credentials are mounted read-only
- **Session Branching**: Each session creates a new branch (`claude/[timestamp]`)
- **Real-time Monitoring**: Commit monitoring with interactive review
- **Web UI Architecture**: Socket.io-based terminal with session persistence and reconnection
- **Shadow Repository Pattern**: Temporary clones track changes without affecting original repo
- **Multi-runtime Support**: Works with both Docker and Podman via automatic detection

### Shadow Repository Sync Principles

The shadow repository maintains a real-time sync with the container's workspace using the following principles:

1. **Git-tracked files take precedence**: Any file that is committed to the git repository will be synced to the shadow repo, regardless of whether it matches patterns in `.gitignore`
2. **Gitignore patterns apply to untracked files**: Files that are not committed to git but match `.gitignore` patterns will be excluded from sync
3. **Built-in exclusions**: Certain directories (`.git`, `node_modules`, `__pycache__`, etc.) are always excluded for performance and safety
4. **Rsync rule order**: Include rules for git-tracked files are processed before exclude rules, ensuring committed files are always preserved

This ensures that important data files (like corpora, model files, etc.) that are committed to the repository are never accidentally deleted during sync operations, even if they match common gitignore patterns like `*.zip` or `*.tar.gz`.

### Web UI Real-time Sync

The web UI uses inotify-based monitoring for real-time file change detection:

1. **inotify Installation**: Automatically installs inotify-tools in container if not present
2. **Debounced Syncing**: Changes are debounced (500ms) to avoid excessive syncs
3. **Continuous Monitoring**: Monitors `/workspace` excluding `.git`, `node_modules`, etc.
4. **Session Management**: Tracks multiple connected sockets per container session
5. **Output History**: Maintains last 100KB of terminal output for reconnecting clients

## Configuration

The tool looks for `claude-run.config.json` in the working directory. Key options:

- `dockerImage`: Base image name (default: `ghcr.io/yanranxiaoxi/claude-code-runner:latest`)
- `buildImage`: Whether to build locally or pull from registry (default: true for local build)
- `dockerfile`: Path to custom Dockerfile
- `environment`: Additional environment variables
- `volumes`: Legacy volume mounts (string format)
- `mounts`: Modern mount configuration (object format with source, target, readonly)
- `allowedTools`: Claude tool permissions (default: all)
- `autoPush`/`autoCreatePR`: Git workflow settings
- `dockerSocketPath`: Custom Docker/Podman socket path (auto-detected by default)
- `containerPrefix`: Custom prefix for container names
- `forwardSshKeys`, `forwardGpgKeys`, `forwardSshAgent`, `forwardGpgAgent`: Credential forwarding options
- `setupCommands`: Commands to run after container starts

## Development Workflow

### Start a new runner with web UI:

```bash
claude-run
```

### Start a new runner on a specific branch:

```bash
claude-run start --branch feature-branch
```

### Attach to existing container:

```bash
claude-run attach [container-id]
```

### Kill all running runner containers:

```bash
claude-run purge -y
```

### Development with local changes:

```bash
npm run link      # Link local version globally
claude-run start  # Test your changes
```

## Build System

The build process (`npm run build`) runs:
1. `rimraf dist` - Clean output directory
2. `tsc` - Compile TypeScript
3. `scripts/inject-data.js` - Inject package metadata into compiled code

The inject script replaces `__PACKAGE_VERSION__` and `__PACKAGE_NAME__` placeholders in the compiled CLI with actual values from package.json for version checking and self-update functionality.
