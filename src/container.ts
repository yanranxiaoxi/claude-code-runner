import type Docker from 'dockerode';
import type { CodeRunner, Credentials, SandboxConfig, WorkspaceMode } from './types';
import { Buffer } from 'node:buffer';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
import tarStream from 'tar-stream';
import { CODE_RUNNERS } from './types';
import { getHostIdentity } from './workspace';

/** Normalize path separators for shell commands (Windows backslash → forward slash) */
function toShellPath(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

/** Get a cross-platform temporary file path */
function getTempFile(prefix: string, extension: string): string {
	return path.join(os.tmpdir(), `${prefix}-${Date.now()}${extension}`);
}

export class ContainerManager {
	private docker: Docker;
	private config: SandboxConfig;
	private containers: Map<string, Docker.Container> = new Map();

	constructor(
		docker: Docker,
		config: SandboxConfig,
		private isPodmanRuntime: boolean = false,
	) {
		this.docker = docker;
		this.config = config;
	}

	async start(containerConfig: any): Promise<string> {
		// Build or pull image
		await this.ensureImage();

		// Create container
		const container = await this.createContainer(containerConfig);
		this.containers.set(container.id, container);

		// Start container
		await container.start();
		console.log(chalk.green('✓ Container started'));

		// Wait a moment for container to stabilize
		await new Promise(resolve => setTimeout(resolve, 500));

		// Verify container is still running
		const containerInfo = await container.inspect();
		if (!containerInfo.State.Running) {
			console.error(chalk.red('✗ Container exited unexpectedly'));
			const logs = await container.logs({ stdout: true, stderr: true, tail: 50 });
			console.error(chalk.yellow('Container logs:'), logs.toString());
			throw new Error('Container exited immediately after start');
		}

		const workspaceMode: WorkspaceMode = containerConfig.workspaceMode || this.config.workspaceMode || 'shadow';

		try {
			if (workspaceMode === 'direct') {
				// The workspace is bind-mounted; copying files would overwrite host files.
				console.log(chalk.blue('• Using direct workspace mount (no file copy)'));
			}
			else {
				// Copy working directory into container
				console.log(chalk.blue('• Copying files into container...'));
				await this._copyWorkingDirectory(container, containerConfig.workDir);
				console.log(chalk.green('✓ Files copied'));
			}

			// Copy Claude configuration if it exists
			await this._copyClaudeConfig(container);

			// Copy OpenCode configuration if it exists
			await this._copyOpencodeConfig(container);

			// Copy Codex configuration if it exists
			await this._copyCodexConfig(container);

			// Copy Kimi Code configuration if it exists
			await this._copyKimiConfig(container);

			// Copy Qwen Code configuration if it exists
			await this._copyQwenConfig(container);

			// Copy git configuration if it exists
			await this._copyGitConfig(container);

			// In direct mode, verify the mounted host directory is writable by the
			// container user before running setup commands or starting the agent.
			if (workspaceMode === 'direct') {
				await this.verifyDirectWorkspaceWritable(container, containerConfig.workDir);
			}
		}
		catch (error) {
			console.error(chalk.red('✗ Container preparation failed:'), error);
			// Clean up container on failure
			await container.stop().catch(() => {});
			await container.remove().catch(() => {});
			this.containers.delete(container.id);
			throw error;
		}

		// Give the container a moment to initialize
		await new Promise(resolve => setTimeout(resolve, 500));
		console.log(chalk.green('✓ Container ready'));

		// Set up git branch and startup script
		await this.setupGitAndStartupScript(
			container,
			containerConfig.branchName,
			containerConfig.prFetchRef,
			containerConfig.remoteFetchRef,
			workspaceMode,
		);

		// Run setup commands
		await this.runSetupCommands(container);

		return container.id;
	}

	private async verifyDirectWorkspaceWritable(container: Docker.Container, workDir: string): Promise<void> {
		const probeName = `.claude-runner-write-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const probePath = path.join(workDir, probeName);

		try {
			const exec = await container.exec({
				Cmd: ['/bin/bash', '-c', `tmp="/workspace/${probeName}"; touch "$tmp" && rm -f "$tmp"`],
				AttachStdout: true,
				AttachStderr: true,
				User: 'claude',
				WorkingDir: '/workspace',
			});

			const stream = await exec.start({});
			await new Promise<void>((resolve, reject) => {
				stream.on('data', () => {});
				stream.on('end', resolve);
				stream.on('error', reject);
			});

			let info = await exec.inspect();
			for (let attempt = 0; attempt < 10 && info.ExitCode === null; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 50));
				info = await exec.inspect();
			}
			if (info.ExitCode !== 0) {
				throw new Error(`write probe exited with code ${info.ExitCode}`);
			}

			console.log(chalk.green('✓ Direct workspace is writable by the container user'));
		}
		catch (error) {
			// Best-effort cleanup of the probe file from the host side.
			try {
				fs.unlinkSync(probePath);
			}
			catch {
				// Ignore cleanup errors.
			}

			throw new Error(
				`The container cannot write to the mounted workspace: ${workDir}\n`
				+ 'This usually means a UID/GID mismatch, a rootless container namespace issue, or SELinux blocking the bind mount.\n'
				+ 'Direct mode was aborted before starting the agent; no workspace files were modified.\n'
				+ `Original error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async ensureImage(): Promise<void> {
		let imageName = this.config.dockerImage || 'claude-code-runner:latest';

		// Auto-add version tag if image name doesn't include a tag
		// When buildImage is false (using pre-built image), use the official versioned image
		if (!imageName.includes(':')) {
			if (this.config.buildImage === false) {
				// For pre-built image, append version tag
				imageName = `${imageName}:v__PACKAGE_VERSION__`;
			}
			else {
				// For local build, append :latest
				imageName = `${imageName}:latest`;
			}
		}

		// Check if image already exists
		try {
			await this.docker.getImage(imageName).inspect();
			console.log(chalk.green(`✓ Using existing image: ${imageName}`));
			return;
		}
		catch (error) {
			// Image doesn't exist, decide whether to build or pull
		}

		// Determine if we should build (default) or pull
		const shouldBuild = this.config.buildImage !== false; // default to true
		const hasLocalDockerfile = this.config.dockerfile || fs.existsSync(path.join(__dirname, '..', 'docker', 'Dockerfile'));

		if (shouldBuild && hasLocalDockerfile) {
			console.log(chalk.blue(`• Building image: ${imageName}...`));

			// Check if we need to build from custom Dockerfile
			if (this.config.dockerfile) {
				await this.buildImage(this.config.dockerfile, imageName);
			}
			else {
				// Use default Dockerfile from docker/ directory
				const defaultDockerfilePath = path.join(__dirname, '..', 'docker', 'Dockerfile');
				console.log(chalk.blue(`• Using default Dockerfile: ${defaultDockerfilePath}`));
				await this.buildImage(defaultDockerfilePath, imageName);
			}
		}
		else if (!shouldBuild) {
			// Pull image from registry
			console.log(chalk.blue(`• Pulling image from registry: ${imageName}...`));
			await this.pullImage(imageName);
		}
		else {
			// No Dockerfile and shouldBuild is false, try to pull
			console.log(chalk.blue(`• Pulling image from registry: ${imageName}...`));
			try {
				await this.pullImage(imageName);
			}
			catch (error) {
				throw new Error(`Failed to pull image '${imageName}' and no Dockerfile available. Please ensure docker/Dockerfile exists or use a pre-built image.`);
			}
		}
	}

	private async pullImage(imageName: string): Promise<void> {
		// Parse image name to get registry info
		const stream = await this.docker.pull(imageName);

		return new Promise((resolve, reject) => {
			const layerProgress = new Map<string, { current: number; total: number }>();
			const layerStatus = new Map<string, string>();

			this.docker.modem.followProgress(
				stream,
				(err: any, res: any) => {
					if (err) {
						reject(err);
					}
					else {
						// Clear the last line and show completion
						process.stdout.write('\r\x1B[K');
						console.log(chalk.green('✓ Image pulled successfully'));
						resolve();
					}
				},
				(event: any) => {
					if (event.status) {
						const layerId = event.id || 'manifest';

						// Track layer status
						if (event.id) {
							layerStatus.set(event.id, event.status);

							// Track download progress
							if (event.progressDetail && event.progressDetail.total) {
								layerProgress.set(event.id, {
									current: event.progressDetail.current || 0,
									total: event.progressDetail.total,
								});
							}
						}

						// Calculate overall progress
						let totalBytes = 0;
						let downloadedBytes = 0;
						let hasProgress = false;

						for (const [id, progress] of layerProgress.entries()) {
							totalBytes += progress.total;
							downloadedBytes += progress.current;
							hasProgress = true;
						}

						// Count layers by status
						const downloading = Array.from(layerStatus.values()).filter(s =>
							s.includes('Downloading') || s.includes('Pulling'),
						).length;
						const complete = Array.from(layerStatus.values()).filter(s =>
							s.includes('Download complete') || s.includes('Already exists') || s.includes('Pull complete'),
						).length;
						const total = layerStatus.size;

						// Format progress message with progress bar
						let message = 'Pulling image: ';

						if (hasProgress && totalBytes > 0) {
							const percentage = Math.floor((downloadedBytes / totalBytes) * 100);
							const barWidth = 30;
							const filledWidth = Math.floor((percentage / 100) * barWidth);
							const emptyWidth = barWidth - filledWidth;

							const progressBar = chalk.green('█'.repeat(filledWidth)) + chalk.gray('░'.repeat(emptyWidth));
							const downloaded = this.formatBytes(downloadedBytes);
							const totalSize = this.formatBytes(totalBytes);

							message += `[${progressBar}] ${percentage}% (${downloaded}/${totalSize})`;
						}
						else if (total > 0) {
							message += `${complete}/${total} layers`;
						}
						else {
							message = event.status;
						}

						// Add layer count info
						if (downloading > 0) {
							message += chalk.dim(` | ${downloading} downloading`);
						}

						// Use \r to overwrite the same line
						process.stdout.write(`\r\x1B[K${chalk.blue('• ')}${message}`);
					}
				},
			);
		});
	}

	private formatBytes(bytes: number): string {
		if (bytes === 0)
			return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
	}

	private async buildImage(
		dockerfilePath: string,
		imageName: string,
	): Promise<void> {
		const buildContext = path.dirname(dockerfilePath);

		const buildStream = await this.docker.buildImage(
			{
				context: buildContext,
				src: [path.basename(dockerfilePath)],
			},
			{
				dockerfile: path.basename(dockerfilePath),
				t: imageName,
			},
		);

		await new Promise((resolve, reject) => {
			this.docker.modem.followProgress(
				buildStream as any,
				(err: any, res: any) => {
					if (err)
						reject(err);
					else resolve(res);
				},
				(event: any) => {
					if (event.stream) {
						process.stdout.write(event.stream);
					}
				},
			);
		});
	}

	private async createContainer(
		containerConfig: any,
	): Promise<Docker.Container> {
		const { credentials, workDir, repoName, workspaceMode, nonGitInit } = containerConfig;
		const mode: WorkspaceMode = workspaceMode || this.config.workspaceMode || 'shadow';

		// Prepare environment variables
		const env = this.prepareEnvironment(credentials, mode);

		// Prepare volumes
		const volumes = this.prepareVolumes(workDir, credentials, mode);

		const hostConfig: any = {
			Binds: volumes.binds,
			Mounts: volumes.mounts,
			AutoRemove: false,
			NetworkMode: 'bridge',
		};

		// Rootless Podman maps the container user to a subuid by default.
		// keep-id keeps the host user available as UID 1000 inside the container,
		// so the claude user can write to the bind-mounted workspace.
		if (mode === 'direct' && this.isPodmanRuntime) {
			const { uid, gid } = getHostIdentity();
			if (uid !== undefined) {
				hostConfig.UsernsMode = uid === 1000 && (gid === undefined || gid === 1000)
					? 'keep-id'
					: 'keep-id:uid=1000,gid=1000';
			}
		}

		// Create container
		const container = await this.docker.createContainer({
			Image: this.config.dockerImage || 'claude-code-runner:latest',
			name: `${
				this.config.containerPrefix || 'claude-code-runner'
			}-${Date.now()}`,
			Env: env,
			Labels: {
				'com.claude.runner.repo': repoName,
				'com.claude.runner.workdir': workDir,
				'com.claude.runner.mode': mode,
				'com.claude.runner.non-git-init': nonGitInit ? 'true' : 'false',
				'com.claude.runner.version': '__PACKAGE_VERSION__',
			},
			HostConfig: hostConfig,
			WorkingDir: '/workspace',
			// Keep the entrypoint as root so it can prepare credentials. Sessions
			// still run as claude. Explicit User also avoids Podman keep-id
			// overriding the entrypoint user.
			User: mode === 'direct' ? 'root' : undefined,
			Cmd: ['/bin/bash', '-l'],
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			Tty: true,
			OpenStdin: true,
			StdinOnce: false,
		});

		return container;
	}

	private prepareEnvironment(credentials: Credentials, workspaceMode: WorkspaceMode): string[] {
		const env = [];

		if (workspaceMode === 'direct') {
			// Protect the host repository from optional index writes and make the
			// direct-mode Git restrictions available to the image's git wrapper.
			env.push('CLAUDE_RUNNER_DIRECT_MODE=1');
			env.push('GIT_OPTIONAL_LOCKS=0');

			// Rootful Docker cannot map the host user automatically. The image
			// entrypoint aligns the claude user with these values when present.
			const { uid, gid } = getHostIdentity();
			if (!this.isPodmanRuntime && process.platform === 'linux' && uid !== undefined && gid !== undefined) {
				env.push(`HOST_UID=${uid}`);
				env.push(`HOST_GID=${gid}`);
			}
		}

		// Load environment variables from .env file if specified
		if (this.config.envFile) {
			try {
				const envFilePath = path.resolve(this.config.envFile);
				if (fs.existsSync(envFilePath)) {
					console.log(
						chalk.blue(`• Loading environment from ${this.config.envFile}...`),
					);

					const envContent = fs.readFileSync(envFilePath, 'utf-8');
					const lines = envContent.split('\n');

					for (const line of lines) {
						const trimmedLine = line.trim();

						// Skip empty lines and comments
						if (!trimmedLine || trimmedLine.startsWith('#')) {
							continue;
						}

						// Skip lines without = sign
						if (!trimmedLine.includes('=')) {
							continue;
						}

						// Parse key=value, handling values with = signs
						const firstEqualIndex = trimmedLine.indexOf('=');
						const key = trimmedLine.substring(0, firstEqualIndex).trim();
						let value = trimmedLine.substring(firstEqualIndex + 1).trim();

						// Remove surrounding quotes if present
						if (
							(value.startsWith('"') && value.endsWith('"'))
							|| (value.startsWith('\'') && value.endsWith('\''))
						) {
							value = value.slice(1, -1);
						}

						if (key) {
							env.push(`${key}=${value}`);
						}
					}

					console.log(
						chalk.green(
							`✓ Loaded ${env.length} environment variables from ${this.config.envFile}`,
						),
					);
				}
				else {
					console.log(
						chalk.yellow(
							`⚠ Environment file ${this.config.envFile} not found`,
						),
					);
				}
			}
			catch (error) {
				console.error(
					chalk.yellow(
						`⚠ Failed to load environment file ${this.config.envFile}:`,
					),
					error,
				);
			}
		}

		// Claude credentials from discovery
		if (credentials.claude) {
			switch (credentials.claude.type) {
				case 'api_key':
					env.push(`ANTHROPIC_API_KEY=${credentials.claude.value}`);
					break;
				case 'bedrock':
					env.push('CLAUDE_CODE_USE_BEDROCK=1');
					if (credentials.claude.region) {
						env.push(`AWS_REGION=${credentials.claude.region}`);
					}
					break;
				case 'vertex':
					env.push('CLAUDE_CODE_USE_VERTEX=1');
					if (credentials.claude.project) {
						env.push(`GOOGLE_CLOUD_PROJECT=${credentials.claude.project}`);
					}
					break;
			}
		}
		else if (process.env.ANTHROPIC_API_KEY) {
			// If no Claude credentials were discovered but ANTHROPIC_API_KEY is in environment, pass it through
			env.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
		}

		// GitHub token - check multiple sources
		if (credentials.github?.token) {
			env.push(`GITHUB_TOKEN=${credentials.github.token}`);
		}
		else if (process.env.GITHUB_TOKEN) {
			// Pass through from environment
			env.push(`GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
		}
		else if (process.env.GH_TOKEN) {
			// GitHub CLI uses GH_TOKEN
			env.push(`GITHUB_TOKEN=${process.env.GH_TOKEN}`);
			env.push(`GH_TOKEN=${process.env.GH_TOKEN}`);
		}

		// Pass through git author info if available
		if (process.env.GIT_AUTHOR_NAME) {
			env.push(`GIT_AUTHOR_NAME=${process.env.GIT_AUTHOR_NAME}`);
		}
		if (process.env.GIT_AUTHOR_EMAIL) {
			env.push(`GIT_AUTHOR_EMAIL=${process.env.GIT_AUTHOR_EMAIL}`);
		}
		if (process.env.GIT_COMMITTER_NAME) {
			env.push(`GIT_COMMITTER_NAME=${process.env.GIT_COMMITTER_NAME}`);
		}
		if (process.env.GIT_COMMITTER_EMAIL) {
			env.push(`GIT_COMMITTER_EMAIL=${process.env.GIT_COMMITTER_EMAIL}`);
		}

		// SSH agent forwarding - if socket is available, set the container path
		const sshAuthSock = process.env.SSH_AUTH_SOCK;
		if (sshAuthSock && fs.existsSync(sshAuthSock)) {
			env.push('SSH_AUTH_SOCK=/tmp/.ssh-agent-sock');
		}

		// GPG agent forwarding - if enabled and socket is available
		const gpgAgentSocket = path.join(os.homedir(), '.gnupg', 'S.gpg-agent');
		if (this.config.forwardGpgAgent === true && fs.existsSync(gpgAgentSocket)) {
			// Point to the container's GPG agent socket relay
			env.push('GPG_TTY=/dev/tty');
			// Set GNUPGHOME to use the forwarded agent
			env.push('GNUPGHOME=/home/claude/.gnupg');
		}
		else {
			// Disable TTY requirement for non-interactive use (no agent available)
			env.push('GPG_TTY=');
		}

		// Pass GPG signing preference to container
		if (this.config.enableGpgSigning) {
			env.push('GIT_COMMIT_GPG_SIGN=true');
		}

		// Additional config
		env.push('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
		if (this.config.maxThinkingTokens) {
			env.push(`MAX_THINKING_TOKENS=${this.config.maxThinkingTokens}`);
		}
		if (this.config.bashTimeout) {
			env.push(`BASH_MAX_TIMEOUT_MS=${this.config.bashTimeout}`);
		}

		// Add custom environment variables
		if (this.config.environment) {
			Object.entries(this.config.environment).forEach(([key, value]) => {
				env.push(`${key}=${value}`);
			});
		}

		return env;
	}

	private prepareVolumes(
		workDir: string,
		_credentials: Credentials,
		workspaceMode: WorkspaceMode,
	): { binds: string[]; mounts: any[] } {
		const binds: string[] = [];
		const mounts: any[] = [];

		if (workspaceMode === 'direct') {
			// Mount the workspace directly. Use the Mounts API to support Windows
			// drive-letter paths without ambiguity in Binds strings.
			mounts.push({
				Type: 'bind',
				Source: workDir,
				Target: '/workspace',
				ReadOnly: false,
			});

			// Keep Git metadata read-only. This prevents the agent from adding
			// hooks, changing config, rewriting refs, or committing through Git.
			const gitPath = path.join(workDir, '.git');
			if (fs.existsSync(gitPath)) {
				const gitSource = fs.realpathSync(gitPath);
				mounts.push({
					Type: 'bind',
					Source: gitSource,
					Target: '/workspace/.git',
					ReadOnly: true,
				});
				console.log(chalk.blue('✓ Git metadata mounted read-only (direct mode)'));
			}

			console.log(chalk.blue(`✓ Mounting ${workDir} → /workspace (read-write)`));
		}

		// Mount SSH directory if it exists and not disabled (read-only for security)
		const forwardSshKeys = this.config.forwardSshKeys !== false; // Default: true
		const sshDir = path.join(os.homedir(), '.ssh');
		if (forwardSshKeys && fs.existsSync(sshDir)) {
			// Mount to /tmp/.host-ssh first, then we'll copy with correct permissions in container
			binds.push(`${sshDir}:/tmp/.host-ssh:ro`);
			console.log(chalk.blue('✓ SSH keys will be available in container'));
		}

		// Mount GPG directory if it exists and not disabled (read-only for security)
		const forwardGpgKeys = this.config.forwardGpgKeys !== false; // Default: true
		const gnupgDir = path.join(os.homedir(), '.gnupg');
		if (forwardGpgKeys && fs.existsSync(gnupgDir)) {
			// Mount to /tmp/.host-gnupg first, then we'll copy with correct permissions in container
			binds.push(`${gnupgDir}:/tmp/.host-gnupg:ro`);
			console.log(chalk.blue('✓ GPG keys will be available in container'));
		}

		// Mount SSH agent socket if available and not disabled (for passphrase-protected keys)
		const forwardSshAgent = this.config.forwardSshAgent !== false; // Default: true
		const sshAuthSock = process.env.SSH_AUTH_SOCK;
		if (forwardSshAgent && sshAuthSock && fs.existsSync(sshAuthSock)) {
			binds.push(`${sshAuthSock}:/tmp/.ssh-agent-sock:rw`);
			console.log(chalk.blue('✓ SSH agent forwarding enabled'));
		}

		// Mount GPG agent socket if available and explicitly enabled (for GPG signing)
		const forwardGpgAgent = this.config.forwardGpgAgent === true; // Default: false - must be explicit
		if (forwardGpgAgent) {
			// GPG agent socket is typically at ~/.gnupg/S.gpg-agent
			const gpgAgentSocket = path.join(os.homedir(), '.gnupg', 'S.gpg-agent');
			if (fs.existsSync(gpgAgentSocket)) {
				binds.push(`${gpgAgentSocket}:/tmp/.gpg-agent-sock:rw`);
				console.log(chalk.blue('✓ GPG agent forwarding enabled'));
			}
			else {
				console.log(chalk.yellow('⚠ GPG agent socket not found - GPG signing may not work'));
			}
		}

		// Add custom volumes (legacy format)
		if (this.config.volumes) {
			for (const volume of this.config.volumes) {
				if (workspaceMode === 'direct' && this.volumeTargetsProtectedWorkspace(volume)) {
					throw new Error(
						`Custom volume "${volume}" targets /workspace or /workspace/.git, which is not allowed in direct workspace mode.`,
					);
				}
				binds.push(volume);
			}
		}

		// Add mount configurations (new format)
		if (this.config.mounts) {
			for (const mount of this.config.mounts) {
				try {
					// Expand environment variables in source path
					let expandedSource = mount.source.replace(/\$HOME/g, os.homedir());
					expandedSource = expandedSource.replace(
						/\$(\w+)/g,
						(match, varName) => {
							return process.env[varName] || match;
						},
					);

					// Resolve the source path
					const sourcePath = path.isAbsolute(expandedSource)
						? expandedSource
						: path.resolve(process.cwd(), expandedSource);

					// Check if source exists
					if (!fs.existsSync(sourcePath)) {
						console.log(
							chalk.yellow(
								`⚠ Mount source does not exist: ${mount.source} (resolved to ${sourcePath})`,
							),
						);
						continue;
					}

					// Expand environment variables in target path
					let expandedTarget = mount.target.replace(/\$HOME/g, '/home/claude');
					expandedTarget = expandedTarget.replace(
						/\$(\w+)/g,
						(match, varName) => {
							// For container paths, we need to use container's environment
							if (varName === 'HOME')
								return '/home/claude';
							return match; // Keep other variables as-is
						},
					);

					// Ensure the container target path is absolute. Always use POSIX
					// separators here, even when running on Windows.
					const targetPath = path.posix.isAbsolute(expandedTarget)
						? expandedTarget
						: path.posix.join('/workspace', expandedTarget);

					if (workspaceMode === 'direct' && this.targetsProtectedWorkspace(targetPath)) {
						throw new Error(
							`Mount target "${targetPath}" targets /workspace or /workspace/.git, which is not allowed in direct workspace mode.`,
						);
					}

					mounts.push({
						Type: 'bind',
						Source: sourcePath,
						Target: targetPath,
						ReadOnly: mount.readonly === true,
					});
					console.log(
						chalk.blue(
							`✓ Mounting ${mount.source} → ${targetPath}${mount.readonly ? ' (read-only)' : ''}`,
						),
					);
				}
				catch (error) {
					if (error instanceof Error && error.message.includes('not allowed in direct workspace mode')) {
						throw error;
					}
					console.error(
						chalk.yellow(`⚠ Failed to process mount ${mount.source}:`),
						error,
					);
				}
			}
		}

		return { binds, mounts };
	}

	private targetsProtectedWorkspace(target: string): boolean {
		const normalized = path.posix.normalize(target.replace(/\\/g, '/')).replace(/\/+$/, '');
		return normalized === '/workspace'
			|| normalized === '/workspace/.git'
			|| normalized.startsWith('/workspace/.git/');
	}

	private volumeTargetsProtectedWorkspace(volume: string): boolean {
		const normalized = volume.replace(/\\/g, '/');
		return /:\/workspace(?:\/\.git(?:\/.*)?)?\/?(?::|$)/.test(normalized);
	}

	private async _copyWorkingDirectory(
		container: Docker.Container,
		workDir: string,
	): Promise<void> {
		// Helper function to get tar flags safely
		const getTarFlags = () => {
			try {
				// Test if --no-xattrs is supported by checking tar help
				execSync('tar --help 2>&1 | grep -q no-xattrs', { stdio: 'pipe' });
				return '--no-xattrs';
			}
			catch {
				// --no-xattrs not supported, use standard tar
				return '';
			}
		};

		try {
			// Get list of git-tracked files (including uncommitted changes)
			const trackedFiles = execSync('git ls-files', {
				cwd: workDir,
				encoding: 'utf-8',
			})
				.trim()
				.split('\n')
				.filter((f: string) => f);

			// Get list of untracked files that aren't ignored (only if includeUntracked is true)
			let untrackedFiles: string[] = [];
			if (this.config.includeUntracked) {
				untrackedFiles = execSync('git ls-files --others --exclude-standard', {
					cwd: workDir,
					encoding: 'utf-8',
				})
					.trim()
					.split('\n')
					.filter((f: string) => f);
			}

			// Combine all files
			const allFiles = [...trackedFiles, ...untrackedFiles];

			console.log(chalk.blue(`• Copying ${allFiles.length} files...`));

			// Create tar archive using git archive for tracked files + untracked files
			const tarFile = getTempFile('claude-runner', '.tar');

			// Check if the repository has any commits (HEAD exists)
			let hasCommits = false;
			try {
				execSync('git rev-parse --verify HEAD', {
					cwd: workDir,
					stdio: 'pipe',
				});
				hasCommits = true;
			}
			catch {
				// No commits yet, HEAD doesn't exist
				hasCommits = false;
			}

			// Create archive of tracked files
			if (hasCommits && trackedFiles.length > 0) {
				// Use git archive for repositories with commits
				execSync(`git archive --format=tar -o "${toShellPath(tarFile)}" HEAD`, {
					cwd: workDir,
					stdio: 'pipe',
				});
			}
			else if (trackedFiles.length > 0) {
				// Use tar for repositories without commits
				const fileListPath = getTempFile('claude-runner-tracked', '.txt');
				fs.writeFileSync(fileListPath, trackedFiles.join('\n'));

				execSync(`tar -cf "${toShellPath(tarFile)}" --files-from="${toShellPath(fileListPath)}"`, {
					cwd: workDir,
					stdio: 'pipe',
				});

				fs.unlinkSync(fileListPath);
			}
			else {
				// No tracked files, create an empty tar archive
				const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
				execSync(`tar -cf "${toShellPath(tarFile)}" -T ${devNull}`, {
					cwd: workDir,
					stdio: 'pipe',
				});
			}

			// Add untracked files if any
			if (untrackedFiles.length > 0) {
				// Create a file list for tar
				const fileListPath = getTempFile('claude-runner-files', '.txt');
				fs.writeFileSync(fileListPath, untrackedFiles.join('\n'));

				// Append untracked files to the tar
				execSync(`tar -rf "${toShellPath(tarFile)}" --files-from="${toShellPath(fileListPath)}"`, {
					cwd: workDir,
					stdio: 'pipe',
				});

				fs.unlinkSync(fileListPath);
			}

			// Read and copy the tar file in chunks to avoid memory issues
			const stream = fs.createReadStream(tarFile);

			// Add timeout for putArchive
			const uploadPromise = container.putArchive(stream, {
				path: '/workspace',
			});

			// Wait for both upload and stream to complete
			await Promise.all([
				uploadPromise,
				new Promise<void>((resolve, reject) => {
					stream.on('end', () => {
						resolve();
					});
					stream.on('error', reject);
				}),
			]);

			// Clean up
			fs.unlinkSync(tarFile);

			// Also copy .git directory to preserve git history
			console.log(chalk.blue('• Copying git history...'));
			const gitTarFile = getTempFile('claude-runner-git', '.tar');
			// Exclude macOS resource fork files and .DS_Store when creating git archive
			// Also strip extended attributes to prevent macOS xattr issues in Docker
			const tarFlags = getTarFlags();
			// On macOS, also exclude extended attributes that cause Docker issues
			const additionalFlags = (process.platform as string) === 'darwin' ? '--no-xattrs --no-fflags' : '';
			const combinedFlags = `${tarFlags} ${additionalFlags}`.trim();
			execSync(
				`tar -cf "${toShellPath(gitTarFile)}" --exclude="._*" --exclude=".DS_Store" ${combinedFlags} .git`,
				{
					cwd: workDir,
					stdio: 'pipe',
				},
			);

			try {
				const gitStream = fs.createReadStream(gitTarFile);

				// Upload git archive
				await container.putArchive(gitStream, {
					path: '/workspace',
				});

				// Clean up
				fs.unlinkSync(gitTarFile);
			}
			catch (error) {
				console.error(chalk.red('✗ Git history copy failed:'), error);
				// Clean up the tar file even if upload failed
				try {
					fs.unlinkSync(gitTarFile);
				}
				catch (e) {
					// Ignore cleanup errors
				}
				throw error;
			}
		}
		catch (error) {
			console.error(chalk.red('✗ Failed to copy files:'), error);
			throw error;
		}
	}

	private async _copyClaudeConfig(container: Docker.Container): Promise<void> {
		// Helper function to get tar flags safely
		const getTarFlags = () => {
			try {
				// Test if --no-xattrs is supported by checking tar help
				execSync('tar --help 2>&1 | grep -q no-xattrs', { stdio: 'pipe' });
				return '--no-xattrs';
			}
			catch {
				// --no-xattrs not supported, use standard tar
				return '';
			}
		};

		try {
			// First, try to get credentials from macOS Keychain if on Mac
			if (process.platform === 'darwin') {
				try {
					console.log(
						chalk.blue('• Checking macOS Keychain for Claude credentials...'),
					);
					const keychainCreds = execSync(
						'security find-generic-password -s "Claude Code-credentials" -w',
						{
							encoding: 'utf-8',
							stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
						},
					).trim();

					if (keychainCreds) {
						console.log(
							chalk.green('✓ Found Claude credentials in macOS Keychain'),
						);

						// Create .claude directory structure
						const claudeDirTar = getTempFile('claude-keychain', '.tar');
						const pack = tarStream.pack();

						// Add .credentials.json to the tar
						pack.entry(
							{ name: '.claude/.credentials.json', mode: 0o600 },
							keychainCreds,
							(err: any) => {
								if (err)
									throw err;
								pack.finalize();
							},
						);

						const chunks: Buffer[] = [];
						pack.on('data', (chunk: any) => chunks.push(chunk));

						await new Promise<void>((resolve, reject) => {
							pack.on('end', () => {
								fs.writeFileSync(claudeDirTar, Buffer.concat(chunks));
								resolve();
							});
							pack.on('error', reject);
						});

						const stream = fs.createReadStream(claudeDirTar);
						await container.putArchive(stream, {
							path: '/home/claude',
						});

						fs.unlinkSync(claudeDirTar);

						// Fix permissions
						await container
							.exec({
								Cmd: [
									'/bin/bash',
									'-c',
									'sudo mkdir -p /home/claude/.claude && sudo chown -R claude:claude /home/claude/.claude && sudo chmod 700 /home/claude/.claude && sudo chmod 600 /home/claude/.claude/.credentials.json',
								],
								AttachStdout: false,
								AttachStderr: false,
							})
							.then(exec => exec.start({}));

						console.log(
							chalk.green('✓ Claude Keychain credentials copied to container'),
						);
					}
				}
				catch (error) {
					// Keychain access failed or credentials not found - not critical
					console.log(
						chalk.yellow('• No Claude credentials found in macOS Keychain'),
					);
				}
			}

			// Copy .claude.json if it exists
			const claudeJsonPath = path.join(os.homedir(), '.claude.json');
			if (fs.existsSync(claudeJsonPath)) {
				console.log(chalk.blue('• Copying .claude.json...'));

				const configContent = fs.readFileSync(claudeJsonPath, 'utf-8');
				const tarFile = getTempFile('claude-json', '.tar');
				const pack = tarStream.pack();

				pack.entry(
					{ name: '.claude.json', mode: 0o644 },
					configContent,
					(err: any) => {
						if (err)
							throw err;
						pack.finalize();
					},
				);

				const chunks: Buffer[] = [];
				pack.on('data', (chunk: any) => chunks.push(chunk));

				await new Promise<void>((resolve, reject) => {
					pack.on('end', () => {
						fs.writeFileSync(tarFile, Buffer.concat(chunks));
						resolve();
					});
					pack.on('error', reject);
				});

				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo chown claude:claude /home/claude/.claude.json && chmod 644 /home/claude/.claude.json',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));
			}

			// Copy .claude directory if it exists (but skip if we already copied from Keychain)
			const claudeDir = path.join(os.homedir(), '.claude');
			if (
				fs.existsSync(claudeDir)
				&& fs.statSync(claudeDir).isDirectory()
				&& process.platform !== 'darwin'
			) {
				console.log(chalk.blue('• Copying .claude directory...'));

				const tarFile = getTempFile('claude-dir', '.tar');
				const tarFlags = getTarFlags();
				// On macOS, also exclude extended attributes that cause Docker issues
				const additionalFlags = (process.platform as string) === 'darwin' ? '--no-xattrs --no-fflags' : '';
				const combinedFlags = `${tarFlags} ${additionalFlags}`.trim();
				execSync(
					`tar -cf "${toShellPath(tarFile)}" ${combinedFlags} -C "${toShellPath(os.homedir())}" .claude`,
					{
						stdio: 'pipe',
					},
				);

				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions recursively
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo chown -R claude:claude /home/claude/.claude && chmod -R 755 /home/claude/.claude',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));
			}

			console.log(chalk.green('✓ Claude configuration copied successfully'));
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy Claude configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async _copyGitConfig(container: Docker.Container): Promise<void> {
		const gitConfigPath = path.join(os.homedir(), '.gitconfig');

		try {
			// Check if the git config file exists
			if (!fs.existsSync(gitConfigPath)) {
				return; // No git config to copy
			}

			console.log(chalk.blue('• Copying git configuration...'));

			// Read the git config file
			const configContent = fs.readFileSync(gitConfigPath, 'utf-8');

			// Create a temporary tar file with the git config
			const tarFile = getTempFile('git-config', '.tar');
			const pack = tarStream.pack();

			// Add the .gitconfig file to the tar
			pack.entry(
				{ name: '.gitconfig', mode: 0o644 },
				configContent,
				(err: any) => {
					if (err)
						throw err;
					pack.finalize();
				},
			);

			// Write the tar to a file
			const chunks: Buffer[] = [];
			pack.on('data', (chunk: any) => chunks.push(chunk));

			await new Promise<void>((resolve, reject) => {
				pack.on('end', () => {
					fs.writeFileSync(tarFile, Buffer.concat(chunks));
					resolve();
				});
				pack.on('error', reject);
			});

			// Copy the tar file to the container's claude user home directory
			const stream = fs.createReadStream(tarFile);
			await container.putArchive(stream, {
				path: '/home/claude', // Copy to claude user's home directory
			});

			// Clean up
			fs.unlinkSync(tarFile);

			// Fix permissions on the copied file
			const fixPermsExec = await container.exec({
				Cmd: [
					'/bin/bash',
					'-c',
					'sudo chown claude:claude /home/claude/.gitconfig',
				],
				AttachStdout: true,
				AttachStderr: true,
			});

			const permStream = await fixPermsExec.start({});
			// Consume the stream to allow it to complete
			await new Promise<void>((resolve, reject) => {
				permStream.on('data', () => {}); // Consume data
				permStream.on('end', resolve);
				permStream.on('error', reject);
			});

			console.log(chalk.green('✓ Git configuration copied successfully'));
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy git configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async _copyOpencodeConfig(container: Docker.Container): Promise<void> {
		try {
			// Check if OpenCode config directory exists on host
			const opencodeConfigDir = path.join(os.homedir(), '.config', 'opencode');
			const opencodeConfigPath = this.config.opencodeConfigPath || path.join(opencodeConfigDir, 'opencode.json');

			// Check if opencode.json exists
			if (fs.existsSync(opencodeConfigPath)) {
				console.log(chalk.blue('• Copying OpenCode configuration...'));

				const configContent = fs.readFileSync(opencodeConfigPath, 'utf-8');
				const tarFile = getTempFile('opencode-config', '.tar');
				const pack = tarStream.pack();

				// Add opencode.json to the tar in the correct location
				pack.entry(
					{ name: '.config/opencode/opencode.json', mode: 0o644 },
					configContent,
					(err: any) => {
						if (err)
							throw err;
						pack.finalize();
					},
				);

				const chunks: Buffer[] = [];
				pack.on('data', (chunk: any) => chunks.push(chunk));

				await new Promise<void>((resolve, reject) => {
					pack.on('end', () => {
						fs.writeFileSync(tarFile, Buffer.concat(chunks));
						resolve();
					});
					pack.on('error', reject);
				});

				// Copy to claude user's home directory
				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo mkdir -p /home/claude/.config/opencode && sudo chown -R claude:claude /home/claude/.config && sudo chmod 755 /home/claude/.config /home/claude/.config/opencode && sudo chmod 644 /home/claude/.config/opencode/opencode.json',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));

				console.log(chalk.green('✓ OpenCode configuration copied successfully'));
			}
			else {
				console.log(chalk.gray('• No OpenCode configuration found to copy'));
			}
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy OpenCode configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async _copyCodexConfig(container: Docker.Container): Promise<void> {
		try {
			// Check if Codex config directory exists on host
			const codexConfigDir = this.config.codexConfigPath || path.join(os.homedir(), '.codex');

			if (fs.existsSync(codexConfigDir) && fs.statSync(codexConfigDir).isDirectory()) {
				console.log(chalk.blue('• Copying Codex configuration...'));

				const tarFile = getTempFile('codex-config', '.tar');
				execSync(
					`tar -cf "${toShellPath(tarFile)}" -C "${toShellPath(path.dirname(codexConfigDir))}" "${path.basename(codexConfigDir)}"`,
					{ stdio: 'pipe' },
				);

				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo chown -R claude:claude /home/claude/.codex && chmod -R 755 /home/claude/.codex',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));

				console.log(chalk.green('✓ Codex configuration copied successfully'));
			}
			else {
				console.log(chalk.gray('• No Codex configuration found to copy'));
			}
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy Codex configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async _copyKimiConfig(container: Docker.Container): Promise<void> {
		try {
			// Check if Kimi Code config directory exists on host
			const kimiConfigDir = this.config.kimiConfigPath || path.join(os.homedir(), '.kimi');

			if (fs.existsSync(kimiConfigDir) && fs.statSync(kimiConfigDir).isDirectory()) {
				console.log(chalk.blue('• Copying Kimi Code configuration...'));

				const tarFile = getTempFile('kimi-config', '.tar');
				execSync(
					`tar -cf "${toShellPath(tarFile)}" -C "${toShellPath(path.dirname(kimiConfigDir))}" "${path.basename(kimiConfigDir)}"`,
					{ stdio: 'pipe' },
				);

				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo chown -R claude:claude /home/claude/.kimi && chmod -R 755 /home/claude/.kimi',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));

				console.log(chalk.green('✓ Kimi Code configuration copied successfully'));
			}
			else {
				console.log(chalk.gray('• No Kimi Code configuration found to copy'));
			}
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy Kimi Code configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async _copyQwenConfig(container: Docker.Container): Promise<void> {
		try {
			// Check if Qwen Code config directory exists on host
			const qwenConfigDir = this.config.qwenConfigPath || path.join(os.homedir(), '.qwen');

			if (fs.existsSync(qwenConfigDir) && fs.statSync(qwenConfigDir).isDirectory()) {
				console.log(chalk.blue('• Copying Qwen Code configuration...'));

				const tarFile = getTempFile('qwen-config', '.tar');
				execSync(
					`tar -cf "${toShellPath(tarFile)}" -C "${toShellPath(path.dirname(qwenConfigDir))}" "${path.basename(qwenConfigDir)}"`,
					{ stdio: 'pipe' },
				);

				const stream = fs.createReadStream(tarFile);
				await container.putArchive(stream, {
					path: '/home/claude',
				});

				fs.unlinkSync(tarFile);

				// Fix permissions
				await container
					.exec({
						Cmd: [
							'/bin/bash',
							'-c',
							'sudo chown -R claude:claude /home/claude/.qwen && chmod -R 755 /home/claude/.qwen',
						],
						AttachStdout: false,
						AttachStderr: false,
					})
					.then(exec => exec.start({}));

				console.log(chalk.green('✓ Qwen Code configuration copied successfully'));
			}
			else {
				console.log(chalk.gray('• No Qwen Code configuration found to copy'));
			}
		}
		catch (error) {
			console.error(
				chalk.yellow('⚠ Failed to copy Qwen Code configuration:'),
				error,
			);
			// Don't throw - this is not critical for container operation
		}
	}

	private async setupGitAndStartupScript(
		container: any,
		branchName: string,
		prFetchRef: string | undefined,
		remoteFetchRef: string | undefined,
		workspaceMode: WorkspaceMode,
	): Promise<void> {
		console.log(chalk.blue('• Setting up workspace and startup script...'));

		// Determine what to show in the web UI
		const defaultShell = this.config.defaultShell || 'claude';

		// Get the code runner configuration
		const codeRunner: CodeRunner = this.config.codeRunner || 'claude';
		const runnerConfig = CODE_RUNNERS[codeRunner];

		// Generate startup script based on the code runner
		const startupScript = this.generateStartupScript(defaultShell, runnerConfig);

		const commands: string[] = [
			'set -e',
			'cd /workspace',
			'GIT_BIN=/usr/bin/git.real',
			'[ -x "$GIT_BIN" ] || GIT_BIN=git',
		];

		if (workspaceMode === 'shadow') {
			commands.push('sudo chown -R claude:claude /workspace');
			// Clean up macOS resource fork files in git pack directory
			commands.push('find .git/objects/pack -name "._pack-*.idx" -type f -delete 2>/dev/null || true');
		}

		// Use git.real for trusted setup writes. In direct mode the git wrapper
		// deliberately rejects mutating commands.
		commands.push('"$GIT_BIN" config --global --add safe.directory /workspace');

		commands.push(
			`ENABLE_GPG_SIGNING="${this.config.enableGpgSigning === true ? 'true' : 'false'}"`,
			`if [ "$ENABLE_GPG_SIGNING" = "true" ]; then
  "$GIT_BIN" config --global commit.gpgsign true
  echo "✓ GPG signing enabled"
else
  "$GIT_BIN" config --global commit.gpgsign false
  echo "✓ GPG signing disabled (enable with enableGpgSigning: true in config)"
fi`,
			`if [ -d "/home/claude/.ssh" ] && [ -z "$SSH_AUTH_SOCK" ]; then
  eval "$(ssh-agent -s)" > /dev/null 2>&1 || true
  for key in /home/claude/.ssh/id_* ; do
    if [ -f "$key" ] && [[ "$key" != *.pub ]]; then
      ssh-add "$key" 2>/dev/null || true
    fi
  done
  echo "✓ SSH agent started"
fi`,
			`if [ -n "$GITHUB_TOKEN" ]; then
  "$GIT_BIN" config --global url."https://\${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  "$GIT_BIN" config --global url."https://\${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"
  echo "✓ Configured git to use GitHub token"
fi`,
		);

		if (workspaceMode === 'shadow') {
			commands.push(
				`if [ -n "${prFetchRef || ''}" ]; then
  echo "• Fetching PR branch..."
  git fetch origin ${prFetchRef}
  git checkout -B "${branchName}" FETCH_HEAD
  echo "✓ Checked out PR branch: ${branchName}"
elif [ -n "${remoteFetchRef || ''}" ]; then
  echo "• Fetching remote branch..."
  git fetch origin
  git checkout -B "${branchName}" "${remoteFetchRef}"
  echo "✓ Checked out remote branch: ${branchName}"
else
  git checkout -B "${branchName}"
  echo "✓ Checked out branch: ${branchName}"
fi`,
			);
		}

		commands.push(
			`cat > /home/claude/start-session.sh << 'EOF'
${startupScript}
EOF`,
			'chmod +x /home/claude/start-session.sh',
			'echo "✓ Workspace setup complete"',
		);

		const setupExec = await container.exec({
			Cmd: ['/bin/bash', '-c', commands.join('\n')],
			AttachStdout: true,
			AttachStderr: true,
			User: workspaceMode === 'direct' ? 'claude' : undefined,
		});

		const setupStream = await setupExec.start({});

		// Wait for the setup process to finish, then rely on its exit code instead
		// of fragile output matching. This also works for direct mode where no
		// branch message is printed.
		await new Promise<void>((resolve, reject) => {
			setupStream.on('data', (chunk: any) => {
				process.stdout.write(chunk);
			});
			setupStream.on('end', resolve);
			setupStream.on('error', reject);
		});

		let setupInfo = await setupExec.inspect();
		for (let attempt = 0; attempt < 10 && setupInfo.ExitCode === null; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 50));
			setupInfo = await setupExec.inspect();
		}

		if (setupInfo.ExitCode !== 0) {
			throw new Error(`Workspace setup failed with exit code ${setupInfo.ExitCode}`);
		}

		console.log(chalk.green('✓ Workspace setup completed'));
	}

	private async runSetupCommands(container: any): Promise<void> {
		// Execute custom setup commands if provided
		if (this.config.setupCommands && this.config.setupCommands.length > 0) {
			if (this.config.workspaceMode === 'direct') {
				console.log(chalk.yellow('⚠ Running approved setup commands in the mounted host directory...'));
			}
			console.log(chalk.blue('• Running custom setup commands...'));
			console.log(
				chalk.blue(
					`  Total commands to run: ${this.config.setupCommands.length}`,
				),
			);

			for (let i = 0; i < this.config.setupCommands.length; i++) {
				const command = this.config.setupCommands[i];
				console.log(
					chalk.yellow(
						`\n[${i + 1}/${this.config.setupCommands.length}] Running command:`,
					),
				);
				console.log(chalk.white(`  ${command}`));

				const cmdExec = await container.exec({
					Cmd: ['/bin/bash', '-c', command],
					AttachStdout: true,
					AttachStderr: true,
					WorkingDir: '/workspace',
					User: 'claude',
				});

				const cmdStream = await cmdExec.start({});

				// Wait for command to complete
				await new Promise<void>((resolve, reject) => {
					let hasError = false;

					cmdStream.on('data', (chunk: any) => {
						process.stdout.write(`  > ${chunk.toString()}`);
					});

					cmdStream.on('end', async () => {
						// Check exit code
						try {
							const info = await cmdExec.inspect();
							if (info.ExitCode !== 0) {
								console.error(
									chalk.red(`✗ Command failed with exit code ${info.ExitCode}`),
								);
								hasError = true;
							}
							else {
								console.log(chalk.green(`✓ Command completed successfully`));
							}
						}
						catch (e) {
							// Ignore inspection errors
						}

						if (hasError && this.config.setupCommands?.includes('set -e')) {
							reject(new Error(`Setup command failed: ${command}`));
						}
						else {
							resolve();
						}
					});

					cmdStream.on('error', reject);
				});
			}

			console.log(chalk.green('✓ All setup commands completed'));
		}
	}

	// Generate startup script based on code runner configuration
	private generateStartupScript(
		defaultShell: string,
		runnerConfig: { name: string; displayName: string; command: string; dangerousFlag: string; pathSetup: string },
	): string {
		const pathSetup = runnerConfig.pathSetup ? `${runnerConfig.pathSetup}\n` : '';
		const runnerCommand = runnerConfig.dangerousFlag
			? `${runnerConfig.command} ${runnerConfig.dangerousFlag}`
			: runnerConfig.command;

		// If shell is 'bash', show welcome message with instructions for all runners
		if (defaultShell === 'bash') {
			return `#!/bin/bash
${pathSetup}
echo "Welcome to Code Runner Sandbox!"
echo "Available commands:"
echo "  - Type 'claude --dangerously-skip-permissions' to start Claude Code"
echo "  - Type 'opencode' to start OpenCode"
echo "  - Type 'codex --dangerously-bypass-approvals-and-sandbox' to start Codex"
echo "  - Type 'kimi --yolo' to start Kimi Code"
echo "  - Type 'qwen --yolo' to start Qwen Code"
echo "  - Type 'exit' to end the session"
echo ""
exec /bin/bash`;
		}

		// Auto-start the configured code runner
		return `#!/bin/bash
${pathSetup}
echo "🚀 Starting ${runnerConfig.displayName}..."
echo "Press Ctrl+C to drop to bash shell"
echo ""

# Run the code runner but don't replace the shell process
${runnerCommand}

# After code runner exits, drop to bash
echo ""
echo "${runnerConfig.displayName} exited. You're now in bash shell."
echo "Type '${runnerCommand}' to restart ${runnerConfig.displayName}"
echo "Type 'exit' to end the session"
echo ""
exec /bin/bash`;
	}

	async cleanup(): Promise<void> {
		for (const [, container] of this.containers) {
			try {
				await container.stop();
				await container.remove();
			}
			catch (error) {
				// Container might already be stopped
			}
		}
		this.containers.clear();
	}
}
