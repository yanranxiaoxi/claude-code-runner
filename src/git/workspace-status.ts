import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

export interface WorkingTreeChanges {
	hasChanges: boolean;
	summary: string;
	diffData: {
		status: string;
		diff: string;
		untrackedFiles: string[];
		stats: {
			additions: number;
			deletions: number;
			files: number;
		};
	};
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: '0',
	};
}

async function runGit(workDir: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		'git',
		['-C', workDir, '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', ...args],
		{
			encoding: 'utf-8',
			env: gitEnv(),
			maxBuffer: MAX_BUFFER,
		},
	);
	return String(stdout);
}

export async function isGitInstalled(): Promise<boolean> {
	try {
		await execFileAsync('git', ['--version'], {
			encoding: 'utf-8',
			env: gitEnv(),
		});
		return true;
	}
	catch {
		return false;
	}
}

export async function isGitRepository(workDir: string): Promise<boolean> {
	try {
		const inside = await runGit(workDir, ['rev-parse', '--is-inside-work-tree']);
		return inside.trim() === 'true';
	}
	catch {
		return false;
	}
}

export async function getCurrentBranch(workDir: string): Promise<string | null> {
	try {
		const branch = await runGit(workDir, ['branch', '--show-current']);
		return branch.trim() || null;
	}
	catch {
		return null;
	}
}

export async function getGitRemoteUrl(workDir: string): Promise<string | null> {
	try {
		const remote = await runGit(workDir, ['remote', 'get-url', 'origin']);
		return remote.trim() || null;
	}
	catch {
		return null;
	}
}

export function calculateDiffStats(diffOutput: string): {
	additions: number;
	deletions: number;
	files: number;
} {
	let additions = 0;
	let deletions = 0;
	const files = new Set<string>();

	for (const line of diffOutput.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) {
			additions++;
		}
		else if (line.startsWith('-') && !line.startsWith('---')) {
			deletions++;
		}
		else if (line.startsWith('diff --git')) {
			const match = line.match(/diff --git a\/(.*?) b\//);
			if (match) {
				files.add(match[1]);
			}
		}
	}

	return { additions, deletions, files: files.size };
}

/**
 * Inspect the working tree without modifying the index or the repository.
 */
export async function getWorkingTreeChanges(workDir: string): Promise<WorkingTreeChanges> {
	const status = await runGit(workDir, ['status', '--porcelain', '-uall']);

	let hasHead = false;
	try {
		await runGit(workDir, ['rev-parse', '--verify', 'HEAD']);
		hasHead = true;
	}
	catch {
		hasHead = false;
	}

	let diff = '';
	try {
		diff = await runGit(
			workDir,
			hasHead
				? ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color']
				: ['diff', '--no-ext-diff', '--no-textconv', '--no-color'],
		);
	}
	catch {
		diff = '';
	}

	const lines = status.split('\n').filter(line => line.length > 0);
	const modified = lines.filter(
		line => line.startsWith(' M') || line.startsWith('M ') || line.startsWith('MM'),
	).length;
	const added = lines.filter(
		line => line.startsWith('??') || line.startsWith('A ') || line.startsWith('AM'),
	).length;
	const deleted = lines.filter(
		line => line.startsWith(' D') || line.startsWith('D '),
	).length;
	const untrackedFiles = lines
		.filter(line => line.startsWith('??'))
		.map(line => line.substring(3));

	return {
		hasChanges: lines.length > 0,
		summary: `Modified: ${modified}, Added: ${added}, Deleted: ${deleted}`,
		diffData: {
			status,
			diff,
			untrackedFiles,
			stats: calculateDiffStats(diff),
		},
	};
}
