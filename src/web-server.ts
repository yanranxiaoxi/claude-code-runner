import type Docker from 'dockerode';
import { Buffer } from 'node:buffer';
import { exec, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import express from 'express';
import * as fs from 'fs-extra';
import { Server } from 'socket.io';
import { getContainerRuntimeCmd } from './docker-config';
import { ShadowRepository } from './git/shadow-repository';

const execAsync = promisify(exec);

interface SessionInfo {
	containerId: string;
	exec?: any;
	stream?: any;
	connectedSockets: Set<string>; // Track connected sockets
	outputHistory?: Buffer[]; // Store output history for replay
}

export class WebUIServer {
	private app: express.Application;
	private httpServer: any;
	private io: Server;
	private docker: Docker;
	private sessions: Map<string, SessionInfo> = new Map(); // container -> session mapping
	private port: number = 3456;
	private shadowRepos: Map<string, ShadowRepository> = new Map(); // container -> shadow repo
	private syncInProgress: Set<string> = new Set(); // Track containers currently syncing
	private originalRepo: string = '';
	private currentBranch: string = 'main';
	private fileWatchers: Map<string, any> = new Map(); // container -> monitor (inotify stream or interval)
	private containerCmd: string; // 'docker' or 'podman'
	private wasNonGitInit: boolean = false;

	constructor(docker: Docker, containerRuntime?: string) {
		this.docker = docker;
		this.containerCmd = containerRuntime || getContainerRuntimeCmd();
		this.app = express();
		this.httpServer = createServer(this.app);
		this.io = new Server(this.httpServer, {
			cors: {
				origin: '*',
				methods: ['GET', 'POST'],
			},
		});

		this.setupRoutes();
		this.setupSocketHandlers();
	}

	private setupRoutes(): void {
		// Serve static files
		this.app.use(express.static(path.join(__dirname, '../public')));

		// Health check endpoint
		this.app.get('/api/health', (_req, res) => {
			res.json({ status: 'ok' });
		});

		// Container info endpoint
		this.app.get('/api/containers', async (_req, res) => {
			try {
				const containers = await this.docker.listContainers();
				const claudeContainers = containers.filter(c =>
					c.Names.some(name => name.includes('claude-code-runner')),
				);
				res.json(claudeContainers);
			}
			catch (error) {
				res.status(500).json({ error: 'Failed to list containers' });
			}
		});

		// Git info endpoint - get current branch and PRs
		this.app.get('/api/git/info', async (req, res) => {
			try {
				const containerId = req.query.containerId as string;
				let currentBranch = 'loading...';
				const workingDir = this.originalRepo || process.cwd();

				// If containerId is provided, try to get branch directly from container first
				if (containerId) {
					try {
						// Get branch directly from the container - this is the most accurate source
						const branchResult = await execAsync(
							`${this.containerCmd} exec ${containerId} git -C /workspace rev-parse --abbrev-ref HEAD`,
						);
						currentBranch = branchResult.stdout.trim();
					}
					catch (containerError) {
						// Container might not be ready, fall back to shadow repo or original repo
						if (this.shadowRepos.has(containerId)) {
							const shadowRepo = this.shadowRepos.get(containerId)!;
							const shadowPath = shadowRepo.getPath();
							if (shadowPath) {
								try {
									const branchResult = await execAsync(
										'git rev-parse --abbrev-ref HEAD',
										{
											cwd: shadowPath,
										},
									);
									currentBranch = branchResult.stdout.trim();
								}
								catch (error) {
									// Shadow repo might not be fully initialized yet, fall back to original repo
									try {
										const branchResult = await execAsync(
											'git rev-parse --abbrev-ref HEAD',
											{
												cwd: workingDir,
											},
										);
										currentBranch = branchResult.stdout.trim();
									}
									catch (fallbackError) {
										// Keep default "loading..."
									}
								}
							}
						}
						else {
							// No shadow repo, fall back to original repo
							try {
								const branchResult = await execAsync(
									'git rev-parse --abbrev-ref HEAD',
									{
										cwd: workingDir,
									},
								);
								currentBranch = branchResult.stdout.trim();
							}
							catch (fallbackError) {
								// Keep default "loading..."
							}
						}
					}
				}
				else {
					// No container ID, use original repo
					try {
						const branchResult = await execAsync(
							'git rev-parse --abbrev-ref HEAD',
							{
								cwd: workingDir,
							},
						);
						currentBranch = branchResult.stdout.trim();
					}
					catch (error) {
						// Keep default "loading..."
					}
				}

				// Get repository remote URL for branch links
				let repoUrl = '';
				let isGitHub = false;
				try {
					const remoteResult = await execAsync('git remote get-url origin', {
						cwd: this.originalRepo || process.cwd(),
					});
					const remoteUrl = remoteResult.stdout.trim();

					// Convert SSH URLs to HTTPS for web links and detect GitHub
					if (remoteUrl.startsWith('git@github.com:')) {
						repoUrl = remoteUrl
							.replace('git@github.com:', 'https://github.com/')
							.replace('.git', '');
						isGitHub = true;
					}
					else if (remoteUrl.includes('github.com')) {
						repoUrl = remoteUrl.replace('.git', '');
						isGitHub = true;
					}
					else if (remoteUrl.startsWith('https://')) {
						repoUrl = remoteUrl.replace('.git', '');
					}
				}
				catch (error) {
					// No origin remote configured; leave repoUrl empty
				}

				// Get PR info using GitHub CLI (only for GitHub repositories)
				let prs = [];
				if (isGitHub) {
					try {
						const prResult = await execAsync(
							`gh pr list --head "${currentBranch}" --json number,title,state,url,isDraft,mergeable`,
							{
								cwd: this.originalRepo || process.cwd(),
							},
						);
						prs = JSON.parse(prResult.stdout || '[]');
					}
					catch (error) {
						// GitHub CLI might not be installed or not authenticated
						// Only log this in debug mode to avoid spam
					}
				}

				const branchUrl = repoUrl ? `${repoUrl}/tree/${currentBranch}` : '';

				res.json({
					currentBranch,
					branchUrl,
					repoUrl,
					prs,
				});
			}
			catch (error) {
				console.error('Failed to get git info:', error);
				res.status(500).json({ error: 'Failed to get git info' });
			}
		});
	}

	private setupSocketHandlers(): void {
		this.io.on('connection', (socket) => {
			console.log(chalk.blue('✓ Client connected to web UI'));

			socket.on('attach', async (data) => {
				const { containerId } = data;

				try {
					const container = this.docker.getContainer(containerId);

					// Check if we already have a session for this container
					let session = this.sessions.get(containerId);

					if (!session || !session.stream) {
						// No existing session, create a new one
						console.log(chalk.blue('Creating new Claude session...'));
						const exec = await container.exec({
							AttachStdin: true,
							AttachStdout: true,
							AttachStderr: true,
							Tty: true,
							Cmd: ['/home/claude/start-session.sh'],
							WorkingDir: '/workspace',
							User: 'claude',
							Env: ['TERM=xterm-256color', 'COLORTERM=truecolor'],
						});

						const stream = await exec.start({
							hijack: true,
							stdin: true,
						});

						session = {
							containerId,
							exec,
							stream,
							connectedSockets: new Set([socket.id]),
							outputHistory: [],
						};
						this.sessions.set(containerId, session);

						// Set up stream handlers that broadcast to all connected sockets
						stream.on('data', (chunk: Buffer) => {
							// Process and broadcast to all connected sockets for this session
							let dataToSend: Buffer;

							if (chunk.length > 8) {
								const firstByte = chunk[0];
								if (firstByte >= 1 && firstByte <= 3) {
									dataToSend = chunk.slice(8);
								}
								else {
									dataToSend = chunk;
								}
							}
							else {
								dataToSend = chunk;
							}

							if (dataToSend.length > 0) {
								// Store in history (limit to last 100KB)
								if (session!.outputHistory) {
									session!.outputHistory.push(Buffer.from(dataToSend));
									let totalSize = session!.outputHistory.reduce(
										(sum, buf) => sum + buf.length,
										0,
									);
									while (
										totalSize > 100000
										&& session!.outputHistory.length > 1
									) {
										const removed = session!.outputHistory.shift();
										if (removed) {
											totalSize -= removed.length;
										}
									}
								}
								// Broadcast to all connected sockets for this container
								for (const socketId of session!.connectedSockets) {
									const connectedSocket = this.io.sockets.sockets.get(socketId);
									if (connectedSocket) {
										connectedSocket.emit('output', new Uint8Array(dataToSend));
									}
								}
							}
						});

						stream.on('error', (err: Error) => {
							console.error(chalk.red('Stream error:'), err);
							// Notify all connected sockets
							for (const socketId of session!.connectedSockets) {
								const connectedSocket = this.io.sockets.sockets.get(socketId);
								if (connectedSocket) {
									connectedSocket.emit('error', { message: err.message });
								}
							}
						});

						stream.on('end', () => {
							// Notify all connected sockets
							for (const socketId of session!.connectedSockets) {
								const connectedSocket = this.io.sockets.sockets.get(socketId);
								if (connectedSocket) {
									connectedSocket.emit('container-disconnected');
								}
							}
							// Stop continuous monitoring
							this.stopContinuousMonitoring(containerId);
							// Clean up session and shadow repo
							this.sessions.delete(containerId);
							if (this.shadowRepos.has(containerId)) {
								this.shadowRepos.get(containerId)?.cleanup();
								this.shadowRepos.delete(containerId);
							}
						});

						console.log(chalk.green('New Claude session started'));

						// Start continuous monitoring for this container
						this.startContinuousMonitoring(containerId);
					}
					else {
						// Add this socket to the existing session
						console.log(chalk.blue('Reconnecting to existing Claude session'));
						session.connectedSockets.add(socket.id);

						// Replay output history to the reconnecting client
						if (session.outputHistory && session.outputHistory.length > 0) {
							console.log(
								chalk.blue(
									`Replaying ${session.outputHistory.length} output chunks`,
								),
							);
							// Send a clear screen first
							socket.emit(
								'output',
								new Uint8Array(Buffer.from('\x1B[2J\x1B[H')),
							);
							// Then replay the history
							for (const chunk of session.outputHistory) {
								socket.emit('output', new Uint8Array(chunk));
							}
						}
					}

					// Confirm attachment
					socket.emit('attached', { containerId, wasNonGitInit: this.wasNonGitInit });

					// Send initial resize after a small delay
					if (session.exec && data.cols && data.rows) {
						setTimeout(async () => {
							try {
								await session.exec.resize({ w: data.cols, h: data.rows });
							}
							catch (e) {
								// Ignore resize errors
							}
						}, 100);
					}
				}
				catch (error: any) {
					// Container not found - likely an old browser tab trying to reconnect
					if (error.statusCode === 404) {
						console.log(chalk.yellow(`⚠ Client tried to attach to non-existent container ${containerId.substring(0, 12)} (old browser tab?)`));
						socket.emit('error', {
							message: 'Container not found. Please refresh the page or close this tab.',
							code: 'CONTAINER_NOT_FOUND',
						});
					}
					else {
						console.error(chalk.red('Failed to attach to container:'), error);
						socket.emit('error', { message: error.message });
					}
				}
			});

			socket.on('resize', async (data) => {
				const { cols, rows } = data;

				// Find which session this socket belongs to
				for (const [, session] of this.sessions) {
					if (session.connectedSockets.has(socket.id) && session.exec) {
						try {
							await session.exec.resize({ w: cols, h: rows });
						}
						catch (error: any) {
							// Ignore HTTP 201 from Podman (it's actually a success response)
							if (error.statusCode === 201) {
								continue;
							}
							console.error(chalk.yellow('Failed to resize terminal:'), error);
						}
						break;
					}
				}
			});

			socket.on('input', (data) => {
				// Find which session this socket belongs to
				for (const [, session] of this.sessions) {
					if (session.connectedSockets.has(socket.id) && session.stream) {
						session.stream.write(data);
						break;
					}
				}
			});

			// Test handler to verify socket connectivity
			socket.on('test-sync', (data) => {
				console.log(chalk.yellow(`[TEST] Received test-sync event:`, data));
			});

			// input-needed handler removed - now using continuous monitoring

			// Handle commit operation
			socket.on('commit-changes', async (data) => {
				const { containerId, commitMessage } = data;

				try {
					const shadowRepo = this.shadowRepos.get(containerId);
					if (!shadowRepo) {
						throw new Error('Shadow repository not found');
					}

					// Perform final sync before commit to ensure we have latest changes
					console.log(chalk.blue('🔄 Final sync before commit...'));
					await shadowRepo.syncFromContainer(containerId);

					const shadowPath = shadowRepo.getPath();

					// Stage all changes
					await execAsync('git add .', { cwd: shadowPath });

					// Create commit
					await execAsync(
						`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
						{
							cwd: shadowPath,
						},
					);

					console.log(chalk.green('✓ Changes committed'));
					socket.emit('commit-success', {
						message: 'Changes committed successfully',
					});
				}
				catch (error: any) {
					console.error(chalk.red('Commit failed:'), error);
					socket.emit('commit-error', { message: error.message });
				}
			});

			// Handle push operation
			socket.on('push-changes', async (data) => {
				const { containerId, branchName } = data;

				try {
					const shadowRepo = this.shadowRepos.get(containerId);
					if (!shadowRepo) {
						throw new Error('Shadow repository not found');
					}

					// Perform final sync before push to ensure we have latest changes
					console.log(chalk.blue('🔄 Final sync before push...'));
					await shadowRepo.syncFromContainer(containerId);

					const shadowPath = shadowRepo.getPath();

					// Create and switch to new branch if specified
					if (branchName && branchName !== 'main') {
						try {
							await execAsync(`git checkout -b ${branchName}`, {
								cwd: shadowPath,
							});
						}
						catch (error) {
							// Branch might already exist, try to switch
							await execAsync(`git checkout ${branchName}`, {
								cwd: shadowPath,
							});
						}
					}

					// Push to remote
					const { stdout: remoteOutput } = await execAsync('git remote -v', {
						cwd: shadowPath,
					});
					if (remoteOutput.includes('origin')) {
						// Get current branch name if not specified
						const pushBranch
							= branchName
								|| (await execAsync('git branch --show-current', {
									cwd: shadowPath,
								}).then(r => r.stdout.trim()));
						await execAsync(`git push -u origin ${pushBranch}`, {
							cwd: shadowPath,
						});
						console.log(chalk.green('✓ Changes pushed to remote'));
						socket.emit('push-success', {
							message: 'Changes pushed successfully',
						});
					}
					else {
						throw new Error('No remote origin configured');
					}
				}
				catch (error: any) {
					console.error(chalk.red('Push failed:'), error);
					socket.emit('push-error', { message: error.message });
				}
			});

			socket.on('disconnect', () => {
				console.log(chalk.yellow('Client disconnected from web UI'));

				// Remove socket from all sessions
				for (const [, session] of this.sessions) {
					session.connectedSockets.delete(socket.id);
				}
			});
		});
	}

	private async performSync(containerId: string): Promise<void> {
		if (this.syncInProgress.has(containerId)) {
			return; // Skip if sync already in progress
		}

		this.syncInProgress.add(containerId);

		try {
			// Initialize shadow repo if not exists
			let isNewShadowRepo = false;
			if (!this.shadowRepos.has(containerId)) {
				const shadowRepo = new ShadowRepository({
					originalRepo: this.originalRepo || process.cwd(),
					claudeBranch: this.currentBranch || 'claude-changes',
					sessionId: containerId.substring(0, 12),
					containerRuntime: this.containerCmd,
				});
				this.shadowRepos.set(containerId, shadowRepo);
				isNewShadowRepo = true;

				// Reset shadow repo to match container's branch (important for PR/remote branch scenarios)
				await shadowRepo.resetToContainerBranch(containerId);
			}

			// Sync files from container (inotify already told us there are changes)
			const shadowRepo = this.shadowRepos.get(containerId)!;
			await shadowRepo.syncFromContainer(containerId);

			// If this is a new shadow repo, establish a clean baseline after the first sync
			if (isNewShadowRepo) {
				console.log(
					chalk.blue('🔄 Establishing clean baseline for new shadow repo...'),
				);
				const shadowPath = shadowRepo.getPath();

				try {
					// Stage all synced files and create a baseline commit
					await execAsync('git add -A', { cwd: shadowPath });
					await execAsync(
						'git commit -m "Establish baseline from container content" --allow-empty',
						{ cwd: shadowPath },
					);
					console.log(chalk.green('✓ Clean baseline established'));

					// Now do one more sync to see if there are any actual changes
					await shadowRepo.syncFromContainer(containerId);
				}
				catch (baselineError) {
					console.warn(
						chalk.yellow('Warning: Could not establish baseline'),
						baselineError,
					);
				}
			}

			// Check if shadow repo actually has git initialized
			const shadowPath = shadowRepo.getPath();
			const gitPath = path.join(shadowPath, '.git');

			if (!(await fs.pathExists(gitPath))) {
				console.log(
					chalk.yellow(
						'Shadow repository .git directory missing - skipping sync',
					),
				);
				return;
			}

			// Get changes summary and diff data
			const changes = await shadowRepo.getChanges();
			console.log(
				chalk.gray(`[MONITOR] Shadow repo changes: ${changes.summary}`),
			);

			let diffData = null;

			if (changes.hasChanges) {
				// Get detailed file status and diffs
				const { stdout: statusOutput } = await execAsync(
					'git status --porcelain',
					{
						cwd: shadowPath,
					},
				);

				// Try git diff HEAD first, fallback to git diff if no HEAD
				let diffOutput = '';
				try {
					const { stdout } = await execAsync('git diff HEAD', {
						cwd: shadowPath,
						maxBuffer: 10 * 1024 * 1024, // 10MB limit
					});
					diffOutput = stdout;
				}
				catch (headError) {
					try {
						// Fallback to git diff (shows unstaged changes)
						const { stdout } = await execAsync('git diff', {
							cwd: shadowPath,
							maxBuffer: 10 * 1024 * 1024, // 10MB limit
						});
						diffOutput = stdout;
					}
					catch (diffError) {
						console.log(chalk.gray('  Could not generate diff, skipping...'));
						diffOutput = 'Could not generate diff';
					}
				}

				// Get list of untracked files with their content
				const untrackedFiles: string[] = [];
				const statusLines = statusOutput
					.split('\n')
					.filter(line => line.startsWith('??'));
				for (const line of statusLines) {
					const filename = line.substring(3);
					untrackedFiles.push(filename);
				}

				// Calculate diff statistics
				const diffStats = this.calculateDiffStats(diffOutput);

				diffData = {
					status: statusOutput,
					diff: diffOutput,
					untrackedFiles,
					stats: diffStats,
				};

				console.log(
					chalk.cyan(`[MONITOR] Changes detected: ${changes.summary}`),
				);
				console.log(chalk.cyan(`[MONITOR] Diff stats:`, diffStats));
			}

			const syncCompleteData = {
				hasChanges: changes.hasChanges,
				summary: changes.summary,
				shadowPath,
				diffData,
				containerId,
			};

			// Send to all connected sockets for this container
			const session = this.sessions.get(containerId);
			if (session) {
				for (const socketId of session.connectedSockets) {
					const connectedSocket = this.io.sockets.sockets.get(socketId);
					if (connectedSocket) {
						connectedSocket.emit('sync-complete', syncCompleteData);
					}
				}
			}
		}
		catch (error: any) {
			console.error(chalk.red('[MONITOR] Sync failed:'), error);
			const session = this.sessions.get(containerId);
			if (session) {
				for (const socketId of session.connectedSockets) {
					const connectedSocket = this.io.sockets.sockets.get(socketId);
					if (connectedSocket) {
						connectedSocket.emit('sync-error', { message: error.message });
					}
				}
			}
		}
		finally {
			this.syncInProgress.delete(containerId);
		}
	}

	private async startContinuousMonitoring(containerId: string): Promise<void> {
		// Clear existing monitoring if any
		this.stopContinuousMonitoring(containerId);

		console.log(
			chalk.blue(
				`[MONITOR] Starting inotify-based monitoring for container ${containerId.substring(0, 12)}`,
			),
		);

		// Do initial sync
		await this.performSync(containerId);

		// Install inotify-tools if not present
		try {
			await execAsync(`${this.containerCmd} exec ${containerId} which inotifywait`);
		}
		catch {
			console.log(chalk.yellow('  Installing inotify-tools in container...'));
			try {
				// Try different package managers
				const installCommands = [
					'dnf install -y inotify-tools',
					'yum install -y inotify-tools',
					'apt-get update && apt-get install -y inotify-tools',
					'apk add --no-cache inotify-tools',
				];

				let installed = false;
				for (const cmd of installCommands) {
					try {
						// Try as root user first, then fallback to regular exec
						try {
							await execAsync(
								`${this.containerCmd} exec --user root ${containerId} sh -c "${cmd}"`,
							);
							installed = true;
							break;
						}
						catch (rootError) {
							// If --user root fails, try without it (container might already be running as root)
							await execAsync(
								`${this.containerCmd} exec ${containerId} sh -c "${cmd}"`,
							);
							installed = true;
							break;
						}
					}
					catch {
						continue;
					}
				}

				if (!installed) {
					console.log(
						chalk.red(
							'  Could not install inotify-tools, falling back to polling monitoring',
						),
					);
					this.startPollingMonitoring(containerId);
					return;
				}
			}
			catch (error) {
				console.log(chalk.red('  Could not install inotify-tools:', error));
				this.startPollingMonitoring(containerId);
				return;
			}
		}

		// Start inotifywait process in container
		const inotifyExec = await this.docker.getContainer(containerId).exec({
			Cmd: [
				'sh',
				'-c',
				`inotifywait -m -r -e modify,create,delete,move --format '%w%f %e' /workspace --exclude '(\.git|node_modules|\.next|__pycache__|\.venv)'`,
			],
			AttachStdout: true,
			AttachStderr: true,
			Tty: false,
		});

		const stream = await inotifyExec.start({ hijack: true, stdin: false });

		let fallbackStarted = false;
		const startFallback = () => {
			if (fallbackStarted)
				return;
			fallbackStarted = true;
			this.stopContinuousMonitoring(containerId);
			this.startPollingMonitoring(containerId);
		};

		// Debounce sync to avoid too many rapid syncs
		let syncTimeout: NodeJS.Timeout | null = null;
		const debouncedSync = () => {
			if (syncTimeout)
				clearTimeout(syncTimeout);
			syncTimeout = setTimeout(async () => {
				console.log(chalk.gray('[INOTIFY] Changes detected, syncing...'));
				await this.performSync(containerId);
			}, 500); // Wait 500ms after last change before syncing
		};

		// Process inotify events
		stream.on('data', (chunk: Buffer) => {
			// Handle docker exec stream format (may have header bytes)
			let data: Buffer;
			if (chunk.length > 8) {
				const firstByte = chunk[0];
				if (firstByte >= 1 && firstByte <= 3) {
					data = chunk.slice(8);
				}
				else {
					data = chunk;
				}
			}
			else {
				data = chunk;
			}

			const output = data.toString();
			if (output.includes('Couldn\'t initialize inotify') || output.includes('Too many open files')) {
				console.log(chalk.yellow('[INOTIFY] Initialization failed, falling back to polling'));
				startFallback();
				return;
			}

			const events = output.trim().split('\n');
			for (const event of events) {
				if (event.trim()) {
					console.log(chalk.gray(`[INOTIFY] ${event}`));
					debouncedSync();
				}
			}
		});

		stream.on('error', (err: Error) => {
			console.error(chalk.red('[INOTIFY] Stream error:'), err);
			startFallback();
		});

		stream.on('end', () => {
			console.log(chalk.yellow('[INOTIFY] Monitoring stopped'));
			startFallback();
		});

		// Store the stream for cleanup
		this.fileWatchers.set(containerId, { stream, exec: inotifyExec } as any);
	}

	private startPollingMonitoring(containerId: string): void {
		console.log(
			chalk.yellow(
				`[MONITOR] Falling back to polling for container ${containerId.substring(0, 12)}`,
			),
		);

		const interval = setInterval(async () => {
			console.log(chalk.gray('[POLL] Syncing files from container...'));
			try {
				await this.performSync(containerId);
			}
			catch (error) {
				console.error(chalk.red('[POLL] Sync failed:'), error);
			}
		}, 2000);

		this.fileWatchers.set(containerId, interval as any);
	}

	private stopContinuousMonitoring(containerId: string): void {
		const monitor = this.fileWatchers.get(containerId);
		if (monitor) {
			// If it's an inotify monitor, close the stream
			if (monitor.stream) {
				monitor.stream.destroy();
			}
			else {
				// Old interval-based monitoring
				clearInterval(monitor as any);
			}
			this.fileWatchers.delete(containerId);
			console.log(
				chalk.blue(
					`[MONITOR] Stopped monitoring for container ${containerId.substring(0, 12)}`,
				),
			);
		}
	}

	private calculateDiffStats(diffOutput: string): {
		additions: number;
		deletions: number;
		files: number;
	} {
		if (!diffOutput)
			return { additions: 0, deletions: 0, files: 0 };

		let additions = 0;
		let deletions = 0;
		const files = new Set<string>();

		const lines = diffOutput.split('\n');
		for (const line of lines) {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				additions++;
			}
			else if (line.startsWith('-') && !line.startsWith('---')) {
				deletions++;
			}
			else if (line.startsWith('diff --git')) {
				// Extract filename from diff header
				const match = line.match(/diff --git a\/(.*?) b\//);
				if (match) {
					files.add(match[1]);
				}
			}
		}

		return { additions, deletions, files: files.size };
	}

	async start(): Promise<string> {
		return new Promise((resolve, reject) => {
			this.httpServer.listen(this.port, () => {
				const url = `http://localhost:${this.port}`;
				console.log(chalk.green(`✓ Web UI server started at ${url}`));
				resolve(url);
			});

			this.httpServer.on('error', (err: any) => {
				if (err.code === 'EADDRINUSE') {
					// Try next port
					this.port++;
					this.httpServer.listen(this.port, () => {
						const url = `http://localhost:${this.port}`;
						console.log(chalk.green(`✓ Web UI server started at ${url}`));
						resolve(url);
					});
				}
				else {
					reject(err);
				}
			});
		});
	}

	setRepoInfo(originalRepo: string, branch: string): void {
		this.originalRepo = originalRepo;
		this.currentBranch = branch;
	}

	setNonGitInit(wasInit: boolean): void {
		this.wasNonGitInit = wasInit;
	}

	async stop(): Promise<void> {
		// Clean up shadow repos
		for (const [, shadowRepo] of this.shadowRepos) {
			await shadowRepo.cleanup();
		}

		// Clean up all sessions
		for (const [, session] of this.sessions) {
			if (session.stream) {
				session.stream.end();
			}
		}
		this.sessions.clear();

		// Close socket.io connections
		this.io.close();

		// Close HTTP server
		return new Promise((resolve) => {
			this.httpServer.close(() => {
				console.log(chalk.yellow('Web UI server stopped'));
				resolve();
			});
		});
	}

	async openInBrowser(url: string): Promise<void> {
		try {
			// Try the open module first
			const open = (await import('open')).default;
			await open(url);
			console.log(chalk.blue('✓ Opened browser'));
		}
		catch (error) {
			// Fallback to platform-specific commands
			try {
				const platform = process.platform;

				if (platform === 'darwin') {
					execSync(`open "${url}"`, { stdio: 'ignore' });
				}
				else if (platform === 'win32') {
					execSync(`start "" "${url}"`, { stdio: 'ignore' });
				}
				else {
					// Linux/Unix
					execSync(
						`xdg-open "${url}" || firefox "${url}" || google-chrome "${url}"`,
						{ stdio: 'ignore' },
					);
				}
				console.log(chalk.blue('✓ Opened browser'));
			}
			catch (fallbackError) {
				console.log(chalk.yellow('Could not open browser automatically'));
				console.log(chalk.yellow(`Please open ${url} in your browser`));
			}
		}
	}
}
