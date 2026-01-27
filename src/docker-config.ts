import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

interface DockerConfig {
	socketPath?: string;
}

/**
 * Detects whether Docker or Podman is available and returns appropriate configuration
 * @param customSocketPath - Optional custom socket path from configuration
 */
export function getDockerConfig(customSocketPath?: string): DockerConfig {
	// Allow override via environment variable
	if (process.env.DOCKER_HOST) {
		return {}; // dockerode will use DOCKER_HOST automatically
	}

	// Use custom socket path if provided
	if (customSocketPath) {
		return { socketPath: customSocketPath };
	}

	// Common socket paths to check
	const socketPaths = [
		// Docker socket paths
		'/var/run/docker.sock',

		// Podman rootless socket paths
		process.env.XDG_RUNTIME_DIR
		&& path.join(process.env.XDG_RUNTIME_DIR, 'podman', 'podman.sock'),
		`/run/user/${process.getuid?.() || 1000}/podman/podman.sock`,

		// Podman root socket path
		'/run/podman/podman.sock',
	].filter(Boolean) as string[];

	// Check each socket path
	for (const socketPath of socketPaths) {
		try {
			if (fs.existsSync(socketPath)) {
				const stats = fs.statSync(socketPath);
				if (stats.isSocket()) {
					return { socketPath };
				}
			}
		}
		catch (error) {
			// Socket might exist but not be accessible, continue checking
			continue;
		}
	}

	// No socket found, return empty config and let dockerode use its defaults
	return {};
}

/**
 * Checks if we're using Podman based on the socket path
 */
export function isPodman(config: DockerConfig): boolean {
	return config.socketPath?.includes('podman') ?? false;
}

/**
 * Gets the container runtime command name ('docker' or 'podman')
 * This should be used when executing shell commands that interact with containers
 */
export function getContainerRuntimeCmd(customSocketPath?: string): string {
	const config = getDockerConfig(customSocketPath);
	return isPodman(config) ? 'podman' : 'docker';
}
