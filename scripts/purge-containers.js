#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const readline = require('node:readline');

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
	dockerImage: 'claude-code-runner:latest',
	buildImage: true,
	containerPrefix: 'claude-code-runner',
};

/**
 * Load configuration from claude-run.config.json
 */
function loadConfig() {
	const configPath = path.resolve(process.cwd(), 'claude-run.config.json');
	try {
		const configContent = fs.readFileSync(configPath, 'utf-8');
		const userConfig = JSON.parse(configContent);

		const finalConfig = {
			...DEFAULT_CONFIG,
			...userConfig,
		};

		// If buildImage is false and dockerImage wasn't explicitly set, use official image
		if (finalConfig.buildImage === false && userConfig.dockerImage === undefined) {
			finalConfig.dockerImage = 'registry.gitlab.soraharu.com/xiaoxi/claude-code-runner:latest';
		}

		return finalConfig;
	}
	catch (error) {
		// Config file not found or invalid, use defaults
		return DEFAULT_CONFIG;
	}
}

/**
 * Detect which container runtime is available
 */
function getContainerRuntime() {
	// Check for Podman socket first
	const uid = os.getuid?.() || 1000;
	const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
	const podmanSocketPath = path.join(xdgRuntimeDir, 'podman', 'podman.sock');

	if (fs.existsSync(podmanSocketPath)) {
		return 'podman';
	}

	// Check root podman socket
	if (fs.existsSync('/run/podman/podman.sock')) {
		return 'podman';
	}

	// Check Docker socket
	if (fs.existsSync('/var/run/docker.sock')) {
		return 'docker';
	}

	// Check DOCKER_HOST environment variable
	if (process.env.DOCKER_HOST) {
		return 'docker';
	}

	// Default to docker
	return 'docker';
}

/**
 * Ask user a yes/no question
 */
function askQuestion(query) {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(query, (answer) => {
			rl.close();
			resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
		});
	});
}

/**
 * Purge Claude Code Runner containers and images
 */
async function purgeContainers() {
	const runtime = getContainerRuntime();
	const config = loadConfig();

	// Collect all image names and container prefixes to clean
	const imageNames = new Set([config.dockerImage]);
	const containerPrefixes = new Set([config.containerPrefix]);

	// Always include defaults in case user ran without config before
	imageNames.add(DEFAULT_CONFIG.dockerImage);
	containerPrefixes.add(DEFAULT_CONFIG.containerPrefix);

	console.log(`🔍 Detected container runtime: ${runtime}`);
	console.log(`📦 Images to clean: ${Array.from(imageNames).join(', ')}`);
	console.log(`🏷️  Container prefixes to clean: ${Array.from(containerPrefixes).join(', ')}`);

	// Ask user if they want to keep the configured image
	const keepConfiguredImage = await askQuestion(
		`\n❓ Do you want to keep the configured image (${config.dockerImage})? (y/n): `,
	);

	// Determine which images to remove
	const imagesToRemove = new Set(imageNames);
	if (keepConfiguredImage) {
		imagesToRemove.delete(config.dockerImage);
		console.log(`✅ Will keep configured image: ${config.dockerImage}`);
	}

	try {
		// Find and remove containers based on image and name
		console.log('\n🧹 Removing containers...');

		const allContainerIds = new Set();

		// Find containers by all image names
		for (const imageName of imageNames) {
			try {
				const listByImageCmd = `${runtime} ps -a --filter "ancestor=${imageName}" -q`;
				const byImage = execSync(listByImageCmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
				if (byImage) {
					byImage.split('\n').filter(id => id.trim()).forEach(id => allContainerIds.add(id.trim()));
				}
			}
			catch (error) {
				// Ignore errors
			}
		}

		// Find containers by all name prefixes
		for (const prefix of containerPrefixes) {
			try {
				const listByNameCmd = `${runtime} ps -a --filter "name=${prefix}" -q`;
				const byName = execSync(listByNameCmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
				if (byName) {
					byName.split('\n').filter(id => id.trim()).forEach(id => allContainerIds.add(id.trim()));
				}
			}
			catch (error) {
				// Ignore errors
			}
		}

		if (allContainerIds.size > 0) {
			const containerList = Array.from(allContainerIds);
			console.log(`Found ${containerList.length} container(s) to remove`);

			// Remove containers one by one to avoid shell parsing issues
			for (const containerId of containerList) {
				try {
					const removeCmd = `${runtime} rm -f ${containerId}`;
					execSync(removeCmd, { stdio: 'inherit' });
				}
				catch (error) {
					console.log(`⚠️  Failed to remove container ${containerId}`);
				}
			}
			console.log('✅ Containers removed');
		}
		else {
			console.log('ℹ️  No containers found');
		}

		// Remove images
		console.log('🗑️  Removing images...');
		let removedCount = 0;
		for (const imageName of imagesToRemove) {
			try {
				const rmiCmd = `${runtime} rmi -f ${imageName}`;
				execSync(rmiCmd, { encoding: 'utf-8', stdio: 'pipe' });
				console.log(`✅ Image removed: ${imageName}`);
				removedCount++;
			}
			catch (error) {
				// Image might not exist
				console.log(`ℹ️  Image not found or in use: ${imageName}`);
			}
		}

		if (removedCount === 0 && imagesToRemove.size > 0) {
			console.log('ℹ️  No images were removed');
		}

		console.log('\n✨ Cleanup complete!');
	}
	catch (error) {
		console.error('❌ Cleanup failed:', error.message);
		process.exit(1);
	}
}

purgeContainers();
