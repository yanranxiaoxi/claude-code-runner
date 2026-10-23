import type { SimpleGit } from 'simple-git';
import type { SandboxConfig, WorkspaceMode } from './types';
import type { GitState } from './workspace';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import Docker from 'dockerode';
import inquirer from 'inquirer';
import { simpleGit } from 'simple-git';
import { ContainerManager } from './container';
import { CredentialManager } from './credentials';
import { getContainerRuntimeCmd, getDockerConfig, isPodman } from './docker-config';
import { GitMonitor } from './git-monitor';
import { UIManager } from './ui';
import { WebUIServer } from './web-server';
import {
	assertNoDirectBranchOptions,
	assertSafeDirectPath,
	detectGitState,
	resolveDirectWorkDir,
	WorkspaceConfigurationError,
} from './workspace';

export class ClaudeSandbox {
	private docker: Docker;
	private git: SimpleGit;
	private config: SandboxConfig;
	private credentialManager: CredentialManager;
	private gitMonitor: GitMonitor;
	private containerManager: ContainerManager;
	private ui: UIManager;
	private webServer?: WebUIServer;
	private containerRuntime: string;
	private wasNonGitInit: boolean = false;
	private workspaceMode: WorkspaceMode = 'shadow';
	private gitState: GitState | null = null;

	constructor(config: SandboxConfig) {
		this.config = config;
		const dockerConfig = getDockerConfig(config.dockerSocketPath);
		this.docker = new Docker(dockerConfig);
		this.containerRuntime = getContainerRuntimeCmd(config.dockerSocketPath);
		const podman = isPodman(dockerConfig);

		// Log if using Podman
		if (podman) {
			console.log(chalk.blue('Detected Podman socket'));
		}

		this.git = simpleGit();
		this.credentialManager = new CredentialManager();
		this.gitMonitor = new GitMonitor(this.git);
		this.containerManager = new ContainerManager(this.docker, config, podman);
		this.ui = new UIManager();
	}

	async run(): Promise<void> {
		// If the mode is already fixed by config, reject incompatible branch
		// options before we even look at existing containers.
		if (this.config.workspaceMode === 'direct') {
			assertNoDirectBranchOptions(this.config);
		}

		// Check for existing containers first
		const existingContainer = await this.checkExistingContainers();
		if (existingContainer) {
			// User chose to reconnect to existing container
			return;
		}

		this.workspaceMode = await this.resolveWorkspaceMode();
		this.config.workspaceMode = this.workspaceMode;
		console.log(chalk.blue(`Workspace mode: ${this.workspaceMode}`));

		let workDir: string;
		let branchName = '';
		let prFetchRef = '';
		let remoteFetchRef = '';

		if (this.workspaceMode === 'direct') {
			workDir = resolveDirectWorkDir();
			assertNoDirectBranchOptions(this.config);
			assertSafeDirectPath(workDir);

			this.gitState = detectGitState(workDir);
			branchName = this.gitState.branch || '';

			this.ui.showDirectModeWarning(workDir);

			if (this.config.autoPush === false || this.config.autoCreatePR === false) {
				console.log(chalk.gray('  Note: --no-push/--no-create-pr have no effect in direct mode.'));
			}
			if (this.config.includeUntracked) {
				console.log(chalk.gray('  Note: includeUntracked has no effect in direct mode; the whole directory is mounted.'));
			}

			if (this.gitState.isRepo) {
				console.log(chalk.blue(`Current branch: ${branchName || '(detached HEAD)'}`));

				if (this.gitState.topLevel && path.resolve(this.gitState.topLevel) !== workDir) {
					console.log(chalk.yellow('⚠ The current directory is not the Git repository root.'));
					console.log(chalk.gray(`  Repository root: ${this.gitState.topLevel}`));
					console.log(chalk.gray('  Direct mode mounts only the current directory; Git metadata may not be available inside the container.'));
				}

				const localGitPath = path.join(workDir, '.git');
				if (fs.existsSync(localGitPath) && fs.lstatSync(localGitPath).isFile()) {
					console.log(chalk.yellow('⚠ .git is a file (linked worktree or submodule).'));
					console.log(chalk.gray('  Git metadata may not be accessible inside the container; host-side change tracking is still used.'));
				}

				if (this.gitState.dirty) {
					console.log(chalk.yellow('⚠ Your working tree has uncommitted changes.'));
					console.log(chalk.gray('  Direct mode modifies files in place and does not create snapshots.'));
				}
			}
			else if (!this.gitState.gitInstalled && fs.existsSync(path.join(workDir, '.git'))) {
				console.log(chalk.yellow('⚠ Git is not installed on the host.'));
				console.log(chalk.gray('  File change tracking will be unavailable; direct file edits still work.'));
			}
			else {
				console.log(chalk.yellow('⚠ No Git repository detected.'));
				console.log(chalk.gray('  File change tracking will be unavailable; direct file edits still work.'));
			}

			await this.prepareDirectSetupCommands(workDir);
		}
		else {
			workDir = process.cwd();

			// Verify we're in a git repository
			await this.verifyGitRepo();

			// Check current branch
			const currentBranch = await this.git.branchLocal();
			console.log(chalk.blue(`Current branch: ${currentBranch.current}`));
			this.gitState = {
				gitInstalled: true,
				isRepo: true,
				branch: currentBranch.current,
				topLevel: workDir,
				dirty: false,
			};

			if (this.config.prNumber) {
				// Get PR branch name from GitHub but don't checkout locally
				console.log(chalk.blue(`Getting PR #${this.config.prNumber} info...`));
				try {
					// Get PR info to find the actual branch name
					const prInfo = execSync(
						`gh pr view ${this.config.prNumber} --json headRefName`,
						{
							encoding: 'utf-8',
							cwd: process.cwd(),
						},
					);
					const prData = JSON.parse(prInfo);
					branchName = prData.headRefName;
					prFetchRef = `pull/${this.config.prNumber}/head:${branchName}`;

					console.log(
						chalk.blue(
							`PR #${this.config.prNumber} uses branch: ${branchName}`,
						),
					);
					console.log(
						chalk.blue(`Will setup container with PR branch: ${branchName}`),
					);
				}
				catch (error) {
					console.error(
						chalk.red(`✗ Failed to get PR #${this.config.prNumber} info:`),
						error,
					);
					throw error;
				}
			}
			else if (this.config.remoteBranch) {
				// Parse remote branch but don't checkout locally
				console.log(
					chalk.blue(
						`Will setup container with remote branch: ${this.config.remoteBranch}`,
					),
				);
				try {
					// Parse remote/branch format
					const parts = this.config.remoteBranch.split('/');
					if (parts.length < 2) {
						throw new Error(
							'Remote branch must be in format "remote/branch" (e.g., "origin/feature-branch")',
						);
					}

					const remote = parts[0];
					const branch = parts.slice(1).join('/');

					console.log(chalk.blue(`Remote: ${remote}, Branch: ${branch}`));
					branchName = branch;
					remoteFetchRef = `${remote}/${branch}`;
				}
				catch (error) {
					console.error(
						chalk.red(
							`✗ Failed to parse remote branch ${this.config.remoteBranch}:`,
						),
						error,
					);
					throw error;
				}
			}
			else {
				// Use target branch from config or generate one
				branchName
					= this.config.targetBranch
						|| (() => {
							const timestamp = new Date()
								.toISOString()
								.replace(/[:.]/g, '-')
								.split('T')[0];
							return `claude/${timestamp}-${Date.now()}`;
						})();
				console.log(
					chalk.blue(`Will create branch in container: ${branchName}`),
				);
			}
		}

		// Discover credentials (optional - don't fail if not found)
		const credentials = await this.credentialManager.discover();

		// Prepare container environment
		const containerConfig = await this.prepareContainer(
			branchName,
			credentials,
			workDir,
			prFetchRef,
			remoteFetchRef,
		);

		// Start container
		const containerId = await this.containerManager.start(containerConfig);
		console.log(
			chalk.green(`✓ Started container: ${containerId.substring(0, 12)}`),
		);

		if (this.workspaceMode === 'shadow') {
			// Start monitoring for commits
			this.gitMonitor.on('commit', async (commit) => {
				await this.handleCommit(commit);
			});

			await this.gitMonitor.start(branchName);
			console.log(chalk.blue('✓ Git monitoring started'));
		}

		// Always launch web UI
		this.webServer = new WebUIServer(this.docker, this.containerRuntime);

		// Pass repo info to web server
		this.webServer.setRepoInfo(workDir, branchName, this.workspaceMode);
		this.webServer.setNonGitInit(this.wasNonGitInit);

		const webUrl = await this.webServer.start();

		// Open browser to the web UI with container ID
		const fullUrl = `${webUrl}?container=${containerId}`;
		await this.webServer.openInBrowser(fullUrl);

		console.log(chalk.green(`\n✓ Web UI available at: ${fullUrl}`));
		console.log(
			chalk.yellow('Keep this terminal open to maintain the session'),
		);

		// Keep the process running
		await new Promise(() => {}); // This will keep the process alive
	}

	private async resolveWorkspaceMode(): Promise<WorkspaceMode> {
		if (this.config.workspaceMode) {
			return this.config.workspaceMode;
		}

		if (!process.stdin.isTTY) {
			console.log(chalk.yellow('⚠ No workspaceMode configured and stdin is not a TTY.'));
			console.log(chalk.gray('  Defaulting to shadow mode to keep unattended runs safe.'));
			return 'shadow';
		}

		const mode = await this.ui.askWorkspaceMode();
		console.log(chalk.gray('Workspace mode selection is not saved to claude-run.config.json.'));
		return mode;
	}

	private async prepareDirectSetupCommands(workDir: string): Promise<void> {
		const commands = Array.isArray(this.config.setupCommands)
			? this.config.setupCommands.filter(command => typeof command === 'string' && command.trim().length > 0)
			: [];
		if (commands.length === 0) {
			return;
		}
		this.config.setupCommands = commands;

		if (!process.stdin.isTTY) {
			console.log(chalk.yellow('⚠ setupCommands were not executed in direct mode.'));
			console.log(chalk.gray('  Explicit confirmation is required, but no TTY is available.'));
			this.config.setupCommands = [];
			return;
		}

		const approved = await this.ui.confirmDirectSetupCommands(workDir, commands);
		if (approved) {
			return;
		}

		console.log(chalk.yellow('⚠ setupCommands skipped: user did not approve running them in the host directory.'));
		this.config.setupCommands = [];
	}

	private async verifyGitRepo(): Promise<void> {
		let isRepo = false;
		try {
			isRepo = await this.git.checkIsRepo();
		}
		catch {
			isRepo = false;
		}
		if (!isRepo) {
			// Ask user if they want to initialize a git repository
			const shouldInit = await this.ui.askGitInit();

			if (shouldInit) {
				try {
					console.log(chalk.blue('Initializing git repository...'));
					await this.git.init();

					// Ensure local git identity so initial commit won't fail
					try {
						const nameConfig = await this.git.getConfig('user.name');
						if (!nameConfig?.value) {
							await this.git.addConfig('user.name', 'Claude Code Runner');
						}
						const emailConfig = await this.git.getConfig('user.email');
						if (!emailConfig?.value) {
							await this.git.addConfig('user.email', 'claude-runner@localhost');
						}
					}
					catch {
						// If config checks fail, continue and let git use global config if available
					}

					// Create initial commit so HEAD exists for archiving
					await this.git.add('.');
					await this.git.commit('Initial commit', undefined, { '--allow-empty': null });

					console.log(chalk.green('✓ Git repository initialized successfully'));
					console.log(chalk.gray('✓ Initial commit created'));
					console.log('');
					console.log(chalk.yellow('⚠ Important: Set up a remote repository to save your changes'));
					console.log(chalk.gray('  Example:'));
					console.log(chalk.gray('    git remote add origin <your-repo-url>'));
					console.log(chalk.gray('    git push -u origin main'));
					console.log('');

					this.wasNonGitInit = true;
				}
				catch (error) {
					throw new Error(`Failed to initialize git repository: ${error}`);
				}
			}
			else {
				throw new Error(
					'Not a git repository. Run claude-run from a Git repository, initialize one, or choose direct workspace mode.',
				);
			}
		}
	}

	private async prepareContainer(
		branchName: string,
		credentials: any,
		workDir: string,
		prFetchRef?: string,
		remoteFetchRef?: string,
	): Promise<any> {
		const repoName = path.basename(workDir);

		return {
			branchName,
			credentials,
			workDir,
			repoName,
			workspaceMode: this.workspaceMode,
			nonGitInit: this.wasNonGitInit,
			gitState: this.gitState,
			dockerImage: this.config.dockerImage || 'claude-code-runner:latest',
			prFetchRef,
			remoteFetchRef,
		};
	}

	private async handleCommit(commit: any): Promise<void> {
		// Show commit notification
		this.ui.showCommitNotification(commit);

		// Show diff
		const diff = await this.git.diff(['HEAD~1', 'HEAD']);
		this.ui.showDiff(diff);

		// Ask user what to do
		const action = await this.ui.askCommitAction();

		switch (action) {
			case 'nothing':
				console.log(chalk.blue('Continuing...'));
				break;
			case 'push':
				await this.pushBranch();
				break;
			case 'push-pr':
				await this.pushBranchAndCreatePR();
				break;
			case 'exit':
				await this.cleanup();
				process.exit(0);
		}
	}

	private async pushBranch(): Promise<void> {
		const currentBranch = await this.git.branchLocal();
		await this.git.push('origin', currentBranch.current);
		console.log(chalk.green(`✓ Pushed branch: ${currentBranch.current}`));
	}

	private async pushBranchAndCreatePR(): Promise<void> {
		await this.pushBranch();

		// Use gh CLI to create PR
		try {
			execSync('gh pr create --fill', { stdio: 'inherit' });
			console.log(chalk.green('✓ Created pull request'));
		}
		catch (error) {
			console.error(
				chalk.yellow(
					'Could not create PR automatically. Please create it manually.',
				),
			);
		}
	}

	private async cleanup(): Promise<void> {
		await this.gitMonitor.stop();
		await this.containerManager.cleanup();
		if (this.webServer) {
			await this.webServer.stop();
		}
	}

	/**
	 * Check for existing running containers from the same project
	 * Returns true if user chooses to reconnect, false otherwise
	 */
	private async checkExistingContainers(): Promise<boolean> {
		// Skip check if configured
		if (this.config.skipReconnectCheck) {
			return false;
		}

		try {
			// Get all running containers
			const containers = await this.docker.listContainers({ all: false });

			if (containers.length === 0) {
				return false;
			}

			// Filter containers with claude-code-runner prefix
			const workDir = process.cwd();
			const repoName = path.basename(workDir);
			const matchingContainers = [];

			for (const container of containers) {
				// Check if container name starts with claude-code-runner
				const containerName = container.Names[0] || '';
				if (!containerName.includes('claude-code-runner')) {
					continue;
				}

				try {
					const containerInfo = await this.docker.getContainer(container.Id).inspect();

					// Check container labels for repo name
					const labels = containerInfo.Config.Labels || {};
					const containerRepoName = labels['com.claude.runner.repo'];
					const containerWorkDir = labels['com.claude.runner.workdir'];
					const sameWorkDir = !containerWorkDir
						|| path.resolve(containerWorkDir) === path.resolve(workDir);

					// Only include containers with matching repo label and workdir
					if (containerRepoName === repoName && sameWorkDir) {
						const mode: WorkspaceMode = labels['com.claude.runner.mode'] === 'direct' ? 'direct' : 'shadow';
						matchingContainers.push({
							id: container.Id,
							name: containerName.substring(1),
							state: container.State,
							status: container.Status,
							mode,
							workDir: labels['com.claude.runner.workdir'] || workDir,
							nonGitInit: labels['com.claude.runner.non-git-init'] === 'true',
						});
					}
				}
				catch {
					// Skip containers we can't inspect
					continue;
				}
			}

			if (matchingContainers.length === 0) {
				return false;
			}

			console.log('');
			console.log(chalk.yellow(`Found ${matchingContainers.length} existing container(s) for this project:`));
			console.log('');

			// Display matching containers
			matchingContainers.forEach((c, idx) => {
				const state = c.state === 'running' ? chalk.green('● Running') : chalk.gray('○ Stopped');
				const mode = c.mode === 'direct' ? chalk.yellow('direct') : chalk.blue('shadow');
				console.log(`  ${idx + 1}. ${chalk.cyan(c.name)} - ${mode} - ${state} (${c.status})`);
			});
			console.log('');

			// Ask user if they want to reconnect
			const { action } = await inquirer.prompt([
				{
					type: 'list',
					name: 'action',
					message: 'Do you want to reconnect to an existing container?',
					choices: [
						{ name: 'Create a new container (recommended)', value: 'new', short: 'New container' },
						{ name: 'Select container to reconnect', value: 'reconnect', short: 'Reconnect' },
					],
					default: 'new',
				},
			]);

			if (action === 'new') {
				console.log(chalk.blue('Will create a new container...'));
				console.log('');
				return false;
			}

			// User wants to reconnect - let them select which container
			const { containerIndex } = await inquirer.prompt([
				{
					type: 'list',
					name: 'containerIndex',
					message: 'Select a container to reconnect:',
					choices: matchingContainers.map((c, idx) => ({
						name: `${c.name} - ${c.mode} - ${c.status}`,
						value: idx,
					})),
				},
			]);

			const selectedContainer = matchingContainers[containerIndex];
			const containerId = selectedContainer.id;

			this.workspaceMode = selectedContainer.mode;
			this.config.workspaceMode = selectedContainer.mode;
			this.wasNonGitInit = selectedContainer.nonGitInit;

			if (this.workspaceMode === 'direct') {
				assertNoDirectBranchOptions(this.config);
			}

			console.log(chalk.blue(`Reconnecting to container: ${selectedContainer.name}...`));

			// Start web UI
			this.webServer = new WebUIServer(this.docker, this.containerRuntime);
			this.webServer.setRepoInfo(selectedContainer.workDir, '', this.workspaceMode);
			this.webServer.setNonGitInit(this.wasNonGitInit);

			const webUrl = await this.webServer.start();
			const fullUrl = `${webUrl}?container=${containerId}`;

			await this.webServer.openInBrowser(fullUrl);

			console.log(chalk.green(`\n✓ Reconnected to container: ${containerId.substring(0, 12)}`));
			console.log(chalk.green(`✓ Web UI available at: ${fullUrl}`));
			console.log(chalk.yellow('Keep this terminal open to maintain the session'));
			console.log('');

			// Keep the process running
			await new Promise(() => {});

			return true;
		}
		catch (error) {
			if (error instanceof WorkspaceConfigurationError) {
				throw error;
			}
			// If there's an error checking containers, just continue with starting a new one
			console.log(chalk.gray('Note: Could not check for existing containers, will create a new one'));
			return false;
		}
	}
}

export * from './types';
