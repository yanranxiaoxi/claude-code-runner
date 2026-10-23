import type { SandboxConfig } from './types';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Error used for user-facing workspace configuration problems.
 * The CLI prints this without a stack trace.
 */
export class WorkspaceConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkspaceConfigurationError';
	}
}

export interface GitState {
	gitInstalled: boolean;
	isRepo: boolean;
	branch: string | null;
	topLevel: string | null;
	dirty: boolean;
}

export interface HostIdentity {
	uid?: number;
	gid?: number;
}

/**
 * Resolve the current directory to a real absolute path.
 */
export function resolveDirectWorkDir(): string {
	try {
		return fs.realpathSync(process.cwd());
	}
	catch (error) {
		throw new WorkspaceConfigurationError(
			`Unable to resolve the current directory "${process.cwd()}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Direct mode always works on the current host checkout. Branch/PR selection
 * would mutate the user's repository, so reject it before touching Docker.
 */
export function assertNoDirectBranchOptions(config: SandboxConfig): void {
	const conflicts: string[] = [];

	if (config.targetBranch)
		conflicts.push('--branch / targetBranch');
	if (config.remoteBranch)
		conflicts.push('--remote-branch / remoteBranch');
	if (config.prNumber)
		conflicts.push('--pr / prNumber');

	if (conflicts.length > 0) {
		throw new WorkspaceConfigurationError(
			`workspaceMode=direct does not support branch/PR options:\n`
			+ `  ${conflicts.join('\n  ')}\n\n`
			+ `Direct mode always uses the current host checkout.\n`
			+ `Switch branches on the host before starting, or use workspaceMode=shadow.`,
		);
	}
}

export function getHostIdentity(): HostIdentity {
	return {
		uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
		gid: typeof process.getgid === 'function' ? process.getgid() : undefined,
	};
}

function stripWindowsLongPathPrefix(value: string): string {
	if (process.platform !== 'win32') {
		return value;
	}
	if (value.startsWith('\\\\?\\UNC\\')) {
		return `\\\\${value.slice(8)}`;
	}
	if (value.startsWith('\\\\?\\')) {
		return value.slice(4);
	}
	return value;
}

function normalizeForCompare(value: string): string {
	const resolved = path.resolve(stripWindowsLongPathPrefix(value));
	return process.platform === 'win32' || process.platform === 'darwin'
		? resolved.toLowerCase()
		: resolved;
}

function addPath(target: Set<string>, candidate: string | undefined): void {
	if (!candidate)
		return;
	target.add(normalizeForCompare(candidate));
}

/**
 * Paths that must never be mounted read-write as a direct workspace.
 * Subdirectories of these paths are allowed.
 */
function getDangerousDirectPaths(): Set<string> {
	const paths = new Set<string>();

	// The root of the current volume/drive.
	addPath(paths, path.parse(process.cwd()).root);
	addPath(paths, os.homedir());
	addPath(paths, os.tmpdir());

	if (process.platform === 'linux') {
		for (const candidate of [
			'/home',
			'/root',
			'/etc',
			'/usr',
			'/bin',
			'/sbin',
			'/lib',
			'/lib32',
			'/lib64',
			'/boot',
			'/dev',
			'/proc',
			'/sys',
			'/run',
			'/var',
			'/opt',
			'/srv',
			'/tmp',
			'/mnt',
			'/media',
		]) {
			addPath(paths, candidate);
		}
	}
	else if (process.platform === 'darwin') {
		for (const candidate of [
			'/System',
			'/Library',
			'/Applications',
			'/Users',
			'/private',
			'/private/etc',
			'/private/tmp',
			'/private/var',
			'/usr',
			'/bin',
			'/sbin',
			'/etc',
			'/var',
			'/tmp',
			'/Volumes',
		]) {
			addPath(paths, candidate);
		}
	}
	else if (process.platform === 'win32') {
		const env = process.env;
		addPath(paths, env.SystemRoot);
		addPath(paths, env.windir);
		addPath(paths, env.ProgramFiles);
		addPath(paths, env['ProgramFiles(x86)']);
		addPath(paths, env.ProgramData);
		addPath(paths, env.SystemDrive ? path.join(env.SystemDrive, 'Users') : undefined);
		addPath(paths, env.SystemDrive ? path.join(env.SystemDrive, 'Windows') : undefined);
	}

	return paths;
}

/**
 * Refuse to mount obviously dangerous directories (system roots, home roots,
 * shared temp roots, or a .git directory) in direct mode.
 */
export function assertSafeDirectPath(workDir: string): void {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(workDir);
	}
	catch (error) {
		throw new WorkspaceConfigurationError(
			`Cannot access the direct workspace "${workDir}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!stats.isDirectory()) {
		throw new WorkspaceConfigurationError(
			`The direct workspace must be a directory: ${workDir}`,
		);
	}

	const identity = getHostIdentity();
	if (identity.uid === 0) {
		throw new WorkspaceConfigurationError(
			'Refusing to run direct workspace mode as root. Run claude-run as a regular user so the container cannot modify host files as root.',
		);
	}

	if (path.basename(workDir).toLowerCase() === '.git') {
		throw new WorkspaceConfigurationError(
			`Refusing to use the Git metadata directory as a direct workspace: ${workDir}`,
		);
	}

	const normalizedWorkDir = normalizeForCompare(workDir);
	if (getDangerousDirectPaths().has(normalizedWorkDir)) {
		throw new WorkspaceConfigurationError(
			`Refusing to use "${workDir}" as a direct workspace.\n`
			+ 'This is a system, home, or shared temporary root and could expose or modify unrelated files.\n'
			+ 'Run claude-run from a project subdirectory instead.',
		);
	}

	try {
		fs.accessSync(workDir, fs.constants.R_OK | fs.constants.W_OK);
	}
	catch {
		throw new WorkspaceConfigurationError(
			`The direct workspace is not readable and writable by the current user: ${workDir}`,
		);
	}
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: '0',
	};
}

function runGit(workDir: string, args: string[], timeout = 5000): string {
	return execFileSync(
		'git',
		['-C', workDir, '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', ...args],
		{
			encoding: 'utf-8',
			env: gitEnv(),
			maxBuffer: 10 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout,
		},
	);
}

/**
 * Detect Git availability and the current branch without modifying the repo.
 */
export function detectGitState(workDir: string): GitState {
	try {
		execFileSync('git', ['--version'], {
			encoding: 'utf-8',
			env: gitEnv(),
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 5000,
		});
	}
	catch {
		return {
			gitInstalled: false,
			isRepo: false,
			branch: null,
			topLevel: null,
			dirty: false,
		};
	}

	let isRepo = false;
	try {
		const inside = runGit(workDir, ['rev-parse', '--is-inside-work-tree']).trim();
		isRepo = inside === 'true';
	}
	catch {
		isRepo = false;
	}

	if (!isRepo) {
		return {
			gitInstalled: true,
			isRepo: false,
			branch: null,
			topLevel: null,
			dirty: false,
		};
	}

	let branch: string | null = null;
	try {
		const current = runGit(workDir, ['branch', '--show-current']).trim();
		branch = current || null;
	}
	catch {
		branch = null;
	}

	let topLevel: string | null = null;
	try {
		topLevel = runGit(workDir, ['rev-parse', '--show-toplevel']).trim() || null;
	}
	catch {
		topLevel = null;
	}

	let dirty = false;
	try {
		dirty = runGit(workDir, ['status', '--porcelain', '-uall']).trim().length > 0;
	}
	catch {
		dirty = false;
	}

	return {
		gitInstalled: true,
		isRepo: true,
		branch,
		topLevel,
		dirty,
	};
}
