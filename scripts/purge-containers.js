#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

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
 * Purge Claude Code Runner containers and images
 */
function purgeContainers() {
	const runtime = getContainerRuntime();
	console.log(`🔍 Detected container runtime: ${runtime}`);

	try {
		// Find and remove containers based on image
		console.log('🧹 Removing claude-code-runner containers...');

		// Also find containers by name pattern
		const listByImageCmd = `${runtime} ps -a --filter "ancestor=claude-code-runner:latest" -q`;
		const listByNameCmd = `${runtime} ps -a --filter "name=claude-code-runner" -q`;

		const allContainerIds = new Set();

		try {
			const byImage = execSync(listByImageCmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
			if (byImage) {
				byImage.split('\n').filter(id => id.trim()).forEach(id => allContainerIds.add(id.trim()));
			}
		}
		catch (error) {
			// Ignore errors
		}

		try {
			const byName = execSync(listByNameCmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
			if (byName) {
				byName.split('\n').filter(id => id.trim()).forEach(id => allContainerIds.add(id.trim()));
			}
		}
		catch (error) {
			// Ignore errors
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

		// Remove image
		console.log('🗑️  Removing claude-code-runner image...');
		try {
			const rmiCmd = `${runtime} rmi -f claude-code-runner:latest`;
			execSync(rmiCmd, { stdio: 'inherit' });
			console.log('✅ Image removed');
		}
		catch (error) {
			// Image might not exist
			console.log('ℹ️  Image not found');
		}

		console.log('\n✨ Cleanup complete!');
	}
	catch (error) {
		console.error('❌ Cleanup failed:', error.message);
		process.exit(1);
	}
}

purgeContainers();
