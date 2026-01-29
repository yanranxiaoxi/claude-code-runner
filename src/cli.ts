#!/usr/bin/env node
import https from 'node:https';
import process from 'node:process';

import chalk from 'chalk';
import { Command } from 'commander';
import Docker from 'dockerode';
import inquirer from 'inquirer';
import ora from 'ora';

import { loadConfig } from './config';
import { getContainerRuntimeCmd, getDockerConfig, isPodman } from './docker-config';
import { ClaudeSandbox } from './index';
import { WebUIServer } from './web-server';

// Package info - injected at build time
const currentVersion = '__PACKAGE_VERSION__';
const packageName = '__PACKAGE_NAME__';

// Check for updates (non-blocking)
async function checkForUpdates(): Promise<void> {
	return new Promise((resolve) => {
		// Set a timeout to avoid blocking the CLI
		const timeout = setTimeout(() => {
			resolve();
		}, 3000);

		https.get(`https://registry.npmjs.org/${packageName}/latest`, (res) => {
			let data = '';

			res.on('data', (chunk) => {
				data += chunk;
			});

			res.on('end', () => {
				clearTimeout(timeout);
				try {
					const latest = JSON.parse(data);
					const latestVersion = latest.version;

					if (latestVersion && latestVersion !== currentVersion) {
						// Compare versions
						if (isNewerVersion(latestVersion, currentVersion)) {
							console.log('');
							console.log(chalk.yellow('┌─────────────────────────────────────────────────────────────┐'));
							console.log(`${chalk.yellow('│')}  ${chalk.bold('Update available! ')}${chalk.dim(currentVersion)} → ${chalk.green(latestVersion)}` + `                 ${chalk.yellow('│')}`);
							console.log(`${chalk.yellow('│')}  ${chalk.dim(`Run: ${chalk.cyan(`npm install -g ${packageName}`)}`)}              ${chalk.yellow('│')}`);
							console.log(chalk.yellow('└─────────────────────────────────────────────────────────────┘'));
							console.log('');
						}
					}
					resolve();
				}
				catch (error) {
					resolve();
				}
			});
		}).on('error', () => {
			clearTimeout(timeout);
			resolve();
		});
	});
}

function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split('.').map(Number);
	const currentParts = current.split('.').map(Number);

	for (let i = 0; i < 3; i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c)
			return true;
		if (l < c)
			return false;
	}
	return false;
}

// Initialize Docker with config - will be updated after loading config if needed
let dockerConfig = getDockerConfig();
let docker = new Docker(dockerConfig);
let containerRuntime = getContainerRuntimeCmd();
const program = new Command();

// Helper function to reinitialize Docker with custom socket path
function reinitializeDocker(socketPath?: string) {
	if (socketPath) {
		dockerConfig = getDockerConfig(socketPath);
		docker = new Docker(dockerConfig);
		containerRuntime = getContainerRuntimeCmd(socketPath);

		// Log if using Podman
		if (isPodman(dockerConfig)) {
			console.log(chalk.blue('Detected Podman socket'));
		}
	}
}

// Helper to ensure Docker is initialized with config
async function ensureDockerConfig() {
	try {
		const config = await loadConfig('./claude-run.config.json');
		reinitializeDocker(config.dockerSocketPath);
	}
	catch (error) {
		// Config loading failed, continue with default Docker config
	}
}

// Helper function to get Claude Runner containers
async function getClaudeSandboxContainers(containerPrefixes?: Set<string>) {
	const containers = await docker.listContainers({ all: true });

	if (containerPrefixes && containerPrefixes.size > 0) {
		// Filter by configured prefixes
		return containers.filter(c =>
			c.Names.some(name =>
				Array.from(containerPrefixes).some(prefix => name.includes(prefix)),
			),
		);
	}

	// Default behavior - filter by default prefix
	return containers.filter(c =>
		c.Names.some(name => name.includes('claude-code-runner')),
	);
}

// Helper function to select a container interactively
async function selectContainer(containers: any[]): Promise<string | null> {
	if (containers.length === 0) {
		console.log(chalk.yellow('No Claude Runner containers found.'));
		return null;
	}

	const choices = containers.map(c => ({
		name: `${c.Names[0].substring(1)} - ${c.State} (${c.Status})`,
		value: c.Id,
		short: c.Id.substring(0, 12),
	}));

	const { containerId } = await inquirer.prompt([
		{
			type: 'list',
			name: 'containerId',
			message: 'Select a container:',
			choices,
		},
	]);

	return containerId;
}

program
	.name('claude-run')
	.description('Run Claude Code in isolated Docker containers')
	.version(currentVersion);

// Check for updates before running any command
program.hook('preAction', async () => {
	await checkForUpdates();
});

// Default command (always web UI)
program
	.option(
		'--shell <shell>',
		'Start with \'claude\' or \'bash\' shell',
		/^(claude|bash)$/i,
	)
	.action(async (options) => {
		console.log(chalk.blue('🚀 Starting Claude Runner...'));

		const config = await loadConfig('./claude-run.config.json');
		config.includeUntracked = false;
		if (options.shell) {
			config.defaultShell = options.shell.toLowerCase();
		}

		const sandbox = new ClaudeSandbox(config);
		await sandbox.run();
	});

// Start command - explicitly start a new container
program
	.command('start')
	.description('Start a new Claude Runner container')
	.option(
		'-c, --config <path>',
		'Configuration file',
		'./claude-run.config.json',
	)
	.option('-n, --name <name>', 'Container name prefix')
	.option('--no-push', 'Disable automatic branch pushing')
	.option('--no-create-pr', 'Disable automatic PR creation')
	.option(
		'--include-untracked',
		'Include untracked files when copying to container',
	)
	.option(
		'-b, --branch <branch>',
		'Switch to specific branch on container start (creates if doesn\'t exist)',
	)
	.option(
		'--remote-branch <branch>',
		'Checkout a remote branch (e.g., origin/feature-branch)',
	)
	.option('--pr <number>', 'Checkout a specific PR by number')
	.option(
		'--shell <shell>',
		'Start with \'claude\' or \'bash\' shell',
		/^(claude|bash)$/i,
	)
	.action(async (options) => {
		console.log(chalk.blue('🚀 Starting new Claude Runner container...'));

		const config = await loadConfig(options.config);
		config.containerPrefix = options.name || config.containerPrefix;
		config.autoPush = options.push !== false;
		config.autoCreatePR = options.createPr !== false;
		config.includeUntracked = options.includeUntracked || false;
		config.targetBranch = options.branch;
		config.remoteBranch = options.remoteBranch;
		config.prNumber = options.pr;
		if (options.shell) {
			config.defaultShell = options.shell.toLowerCase();
		}

		const sandbox = new ClaudeSandbox(config);
		await sandbox.run();
	});

// Attach command - attach to existing container
program
	.command('attach [container-id]')
	.description('Attach to an existing Claude Runner container')
	.action(async (containerId) => {
		await ensureDockerConfig();
		const spinner = ora('Looking for containers...').start();

		try {
			let targetContainerId = containerId;

			// If no container ID provided, show selection UI
			if (!targetContainerId) {
				spinner.stop();
				const containers = await getClaudeSandboxContainers();
				targetContainerId = await selectContainer(containers);

				if (!targetContainerId) {
					console.log(chalk.red('No container selected.'));
					process.exit(1);
				}
			}

			spinner.text = 'Launching web UI...';

			// Always launch web UI
			const webServer = new WebUIServer(docker, containerRuntime);
			const url = await webServer.start();
			const fullUrl = `${url}?container=${targetContainerId}`;

			spinner.succeed(chalk.green(`Web UI available at: ${fullUrl}`));
			await webServer.openInBrowser(fullUrl);

			console.log(
				chalk.yellow('Keep this terminal open to maintain the session'),
			);

			// Keep process running
			await new Promise(() => {});
		}
		catch (error: any) {
			spinner.fail(chalk.red(`Failed: ${error.message}`));
			process.exit(1);
		}
	});

// List command - list all Claude Runner containers
program
	.command('list')
	.alias('ls')
	.description('List all Claude Runner containers')
	.option('-a, --all', 'Show all containers (including stopped)')
	.action(async (options) => {
		await ensureDockerConfig();
		const spinner = ora('Fetching containers...').start();

		try {
			const containers = await docker.listContainers({ all: options.all });
			const claudeContainers = containers.filter(c =>
				c.Names.some(name => name.includes('claude-code-runner')),
			);

			spinner.stop();

			if (claudeContainers.length === 0) {
				console.log(chalk.yellow('No Claude Runner containers found.'));
				return;
			}

			console.log(
				chalk.blue(
					`Found ${claudeContainers.length} Claude Runner container(s):\n`,
				),
			);

			claudeContainers.forEach((c) => {
				const name = c.Names[0].substring(1);
				const id = c.Id.substring(0, 12);
				const state
					= c.State === 'running' ? chalk.green(c.State) : chalk.gray(c.State);
				const status = c.Status;

				console.log(`${chalk.cyan(id)} - ${name} - ${state} - ${status}`);
			});
		}
		catch (error: any) {
			spinner.fail(chalk.red(`Failed: ${error.message}`));
			process.exit(1);
		}
	});

// Stop command - stop Claude Runner containers
program
	.command('stop [container-id]')
	.description('Stop Claude Runner container(s)')
	.option('-a, --all', 'Stop all Claude Runner containers')
	.action(async (containerId, options) => {
		await ensureDockerConfig();
		const spinner = ora('Stopping containers...').start();

		try {
			if (options.all) {
				// Stop all Claude Runner containers
				const containers = await getClaudeSandboxContainers();
				const runningContainers = containers.filter(
					c => c.State === 'running',
				);

				if (runningContainers.length === 0) {
					spinner.info('No running Claude Runner containers found.');
					return;
				}

				for (const c of runningContainers) {
					const container = docker.getContainer(c.Id);
					await container.stop();
					spinner.text = `Stopped ${c.Id.substring(0, 12)}`;
				}

				spinner.succeed(`Stopped ${runningContainers.length} container(s)`);
			}
			else {
				// Stop specific container
				let targetContainerId = containerId;

				if (!targetContainerId) {
					spinner.stop();
					const containers = await getClaudeSandboxContainers();
					const runningContainers = containers.filter(
						c => c.State === 'running',
					);
					targetContainerId = await selectContainer(runningContainers);

					if (!targetContainerId) {
						console.log(chalk.red('No container selected.'));
						process.exit(1);
					}
					spinner.start();
				}

				const container = docker.getContainer(targetContainerId);
				await container.stop();
				spinner.succeed(
					`Stopped container ${targetContainerId.substring(0, 12)}`,
				);
			}
		}
		catch (error: any) {
			spinner.fail(chalk.red(`Failed: ${error.message}`));
			process.exit(1);
		}
	});

// Logs command - view container logs
program
	.command('logs [container-id]')
	.description('View logs from a Claude Runner container')
	.option('-f, --follow', 'Follow log output')
	.option('-n, --tail <lines>', 'Number of lines to show from the end', '50')
	.action(async (containerId, options) => {
		try {
			await ensureDockerConfig();
			let targetContainerId = containerId;

			if (!targetContainerId) {
				const containers = await getClaudeSandboxContainers();
				targetContainerId = await selectContainer(containers);

				if (!targetContainerId) {
					console.log(chalk.red('No container selected.'));
					process.exit(1);
				}
			}

			const container = docker.getContainer(targetContainerId);
			const logStream = await container.logs({
				stdout: true,
				stderr: true,
				follow: options.follow,
				tail: Number.parseInt(options.tail),
			});

			// Docker logs come with headers, we need to parse them
			container.modem.demuxStream(logStream, process.stdout, process.stderr);

			if (options.follow) {
				console.log(chalk.gray('Following logs... Press Ctrl+C to exit'));
			}
		}
		catch (error: any) {
			console.error(chalk.red(`Failed: ${error.message}`));
			process.exit(1);
		}
	});

// Clean command - remove stopped containers
program
	.command('clean')
	.description('Remove all stopped Claude Runner containers')
	.option('-f, --force', 'Remove all containers (including running)')
	.action(async (options) => {
		await ensureDockerConfig();
		const spinner = ora('Cleaning up containers...').start();

		try {
			// Load config to get custom container prefix
			const config = await loadConfig('./claude-run.config.json');

			// Collect all container prefixes to clean
			const containerPrefixes = new Set<string>();
			if (config.containerPrefix) {
				containerPrefixes.add(config.containerPrefix);
			}
			// Always include default prefix
			containerPrefixes.add('claude-code-runner');

			spinner.text = `Looking for containers with prefixes: ${Array.from(containerPrefixes).join(', ')}`;

			const containers = await getClaudeSandboxContainers(containerPrefixes);
			const targetContainers = options.force
				? containers
				: containers.filter(c => c.State !== 'running');

			if (targetContainers.length === 0) {
				spinner.info('No containers to clean up.');
				return;
			}

			for (const c of targetContainers) {
				const container = docker.getContainer(c.Id);
				if (c.State === 'running' && options.force) {
					await container.stop();
				}
				await container.remove();
				spinner.text = `Removed ${c.Id.substring(0, 12)}`;
			}

			spinner.succeed(`Cleaned up ${targetContainers.length} container(s)`);
		}
		catch (error: any) {
			spinner.fail(chalk.red(`Failed: ${error.message}`));
			process.exit(1);
		}
	});

// Purge command - stop and remove all containers and images
program
	.command('purge')
	.description('Stop and remove all Claude Runner containers and images')
	.option('-y, --yes', 'Skip confirmation prompt')
	.action(async (options) => {
		try {
			await ensureDockerConfig();

			// Load config
			const config = await loadConfig('./claude-run.config.json');

			// Collect all container prefixes and image names to clean
			const containerPrefixes = new Set<string>();
			const imageNames = new Set<string>();

			if (config.containerPrefix) {
				containerPrefixes.add(config.containerPrefix);
			}
			if (config.dockerImage) {
				imageNames.add(config.dockerImage);
			}

			// Always include defaults
			containerPrefixes.add('claude-code-runner');
			imageNames.add('claude-code-runner:latest');

			const containers = await getClaudeSandboxContainers(containerPrefixes);

			if (containers.length === 0 && imageNames.size === 0) {
				console.log(chalk.yellow('No Claude Runner containers or images found.'));
				return;
			}

			// Show what will be removed
			if (containers.length > 0) {
				console.log(
					chalk.yellow(`Found ${containers.length} Claude Runner container(s):`),
				);
				containers.forEach((c) => {
					console.log(
						`  ${c.Id.substring(0, 12)} - ${c.Names[0].replace('/', '')} - ${c.State}`,
					);
				});
			}

			console.log(chalk.yellow(`\nImages to clean: ${Array.from(imageNames).join(', ')}`));

			// Ask if user wants to keep the configured image
			let keepConfiguredImage = false;
			if (config.dockerImage && !options.yes) {
				const { keep } = await inquirer.prompt([
					{
						type: 'confirm',
						name: 'keep',
						message: `Do you want to keep the configured image (${config.dockerImage})?`,
						default: false,
					},
				]);
				keepConfiguredImage = keep;
			}

			const imagesToRemove = new Set(imageNames);
			if (keepConfiguredImage && config.dockerImage) {
				imagesToRemove.delete(config.dockerImage);
				console.log(chalk.green(`✓ Will keep configured image: ${config.dockerImage}`));
			}

			// Confirm unless -y flag is used
			if (!options.yes) {
				const { confirm } = await inquirer.prompt([
					{
						type: 'confirm',
						name: 'confirm',
						message: 'Are you sure you want to stop and remove all containers and images?',
						default: false,
					},
				]);

				if (!confirm) {
					console.log(chalk.gray('Purge cancelled.'));
					return;
				}
			}

			const spinner = ora('Purging containers...').start();
			let removedContainers = 0;

			// Remove containers
			for (const c of containers) {
				try {
					const container = docker.getContainer(c.Id);
					spinner.text = `Stopping ${c.Id.substring(0, 12)}...`;

					if (c.State === 'running') {
						await container.stop({ t: 5 }); // 5 second timeout
					}

					spinner.text = `Removing ${c.Id.substring(0, 12)}...`;
					await container.remove();
					removedContainers++;
				}
				catch (error: any) {
					spinner.warn(
						`Failed to remove container ${c.Id.substring(0, 12)}: ${error.message}`,
					);
				}
			}

			if (removedContainers > 0) {
				spinner.succeed(chalk.green(`✓ Removed ${removedContainers} container(s)`));
			}

			// Remove images
			spinner.start('Removing images...');
			let removedImages = 0;

			for (const imageName of imagesToRemove) {
				try {
					const image = docker.getImage(imageName);
					await image.remove({ force: true });
					spinner.text = `Removed image: ${imageName}`;
					removedImages++;
				}
				catch (error: any) {
					// Image might not exist or be in use
					spinner.warn(`Image not found or in use: ${imageName}`);
				}
			}

			if (removedImages > 0) {
				spinner.succeed(chalk.green(`✓ Removed ${removedImages} image(s)`));
			}
			else if (imagesToRemove.size > 0) {
				spinner.info('No images were removed');
			}

			console.log(chalk.green('\n✨ Purge complete!'));
		}
		catch (error: any) {
			console.error(chalk.red(`Purge failed: ${error.message}`));
			process.exit(1);
		}
	});

// Config command - show configuration
program
	.command('config')
	.description('Show current configuration')
	.option(
		'-p, --path <path>',
		'Configuration file path',
		'./claude-run.config.json',
	)
	.action(async (options) => {
		try {
			const config = await loadConfig(options.path);
			console.log(chalk.blue('Current configuration:'));
			console.log(JSON.stringify(config, null, 2));
		}
		catch (error: any) {
			console.error(chalk.red(`Failed to load config: ${error.message}`));
			process.exit(1);
		}
	});

program.parse();
