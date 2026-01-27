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
		const listCmd = `${runtime} ps -a --filter "ancestor=claude-code-runner:latest" -q`;

		try {
			const containerIds = execSync(listCmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
			if (containerIds) {
				const removeCmd = `${runtime} rm -f ${containerIds}`;
				execSync(removeCmd, { stdio: 'inherit' });
				console.log('✅ Containers removed');
			}
			else {
				console.log('ℹ️  No containers found');
			}
		}
		catch (error) {
			// No containers found or command failed, continue
			console.log('ℹ️  No containers found');
		}

		// Remove image
		console.log('🗑️  Removing claude-code-runner image...');
		try {
			const rmiCmd = `${runtime} rmi claude-code-runner:latest`;
			execSync(rmiCmd, { stdio: 'inherit' });
			console.log('✅ Image removed');
		}
		catch (error) {
			// Image might not exist or be in use
			console.log('ℹ️  Image not found or in use');
		}

		console.log('\n✨ Cleanup complete!');
	}
	catch (error) {
		console.error('❌ Cleanup failed:', error.message);
		process.exit(1);
	}
}

purgeContainers();
