import type { CodeRunner, SandboxConfig } from './types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWorkspaceMode } from './types';

const DEFAULT_CONFIG: SandboxConfig = {
	dockerImage: 'claude-code-runner',
	buildImage: true, // Build locally by default, set to false to pull from registry
	useNightlyImage: false, // When buildImage is false and the image has no explicit tag, use nightly instead of the versioned tag
	autoPush: true,
	autoCreatePR: true,
	autoStartClaude: true,
	webUiHost: '127.0.0.1',
	webUiPort: 3456,
	webUiAllowRemote: false,
	defaultShell: 'claude', // Default to Claude mode for backward compatibility
	codeRunner: 'claude', // Default to Claude Code
	claudeConfigPath: path.join(os.homedir(), '.claude.json'),
	opencodeConfigPath: path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
	codexConfigPath: path.join(os.homedir(), '.codex'),
	kimiConfigPath: path.join(os.homedir(), '.kimi'),
	qwenConfigPath: path.join(os.homedir(), '.qwen'),
	setupCommands: [], // Example: ["npm install", "pip install -r requirements.txt"]
	allowedTools: ['*'], // All tools allowed in sandbox
	includeUntracked: false, // Don't include untracked files by default
	// maxThinkingTokens: 100000,
	// bashTimeout: 600000, // 10 minutes
};

// Helper to determine code runner from shell setting for backward compatibility
function resolveCodeRunner(config: SandboxConfig): CodeRunner {
	// If codeRunner is explicitly set, use it
	if (config.codeRunner) {
		return config.codeRunner;
	}
	// For backward compatibility: if defaultShell is set, derive codeRunner
	if (config.defaultShell === 'opencode') {
		return 'opencode';
	}
	if (config.defaultShell === 'codex') {
		return 'codex';
	}
	if (config.defaultShell === 'kimi') {
		return 'kimi';
	}
	if (config.defaultShell === 'qwen') {
		return 'qwen';
	}
	return 'claude';
}

export async function loadConfig(configPath: string): Promise<SandboxConfig> {
	let userConfig: Partial<SandboxConfig>;

	try {
		const fullPath = path.resolve(configPath);
		const configContent = await fs.readFile(fullPath, 'utf-8');
		const parsed = JSON.parse(configContent);
		userConfig = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed
			: {};
	}
	catch {
		// Config file not found or invalid, use a fresh copy of the defaults.
		return { ...DEFAULT_CONFIG };
	}

	if (userConfig.workspaceMode !== undefined && !isWorkspaceMode(userConfig.workspaceMode)) {
		throw new Error(
			`Invalid workspaceMode "${String(userConfig.workspaceMode)}". Expected "shadow" or "direct".`,
		);
	}

	if (userConfig.webUiHost !== undefined && (typeof userConfig.webUiHost !== 'string' || userConfig.webUiHost.trim().length === 0)) {
		throw new Error('Invalid webUiHost. Expected a non-empty hostname or IP address.');
	}

	if (
		userConfig.webUiPort !== undefined
		&& (!Number.isInteger(userConfig.webUiPort) || userConfig.webUiPort < 1 || userConfig.webUiPort > 65535)
	) {
		throw new Error(`Invalid webUiPort "${String(userConfig.webUiPort)}". Expected an integer between 1 and 65535.`);
	}

	if (userConfig.webUiAllowRemote !== undefined && typeof userConfig.webUiAllowRemote !== 'boolean') {
		throw new Error('Invalid webUiAllowRemote. Expected true or false.');
	}

	// Merge with defaults
	const finalConfig = {
		...DEFAULT_CONFIG,
		...userConfig,
	};

	finalConfig.webUiHost = (finalConfig.webUiHost || '127.0.0.1').trim();

	// Resolve code runner for backward compatibility
	finalConfig.codeRunner = resolveCodeRunner(finalConfig);

	// Sync defaultShell with codeRunner if not explicitly set to 'bash'
	if (finalConfig.defaultShell !== 'bash') {
		finalConfig.defaultShell = finalConfig.codeRunner;
	}

	// If buildImage is false and dockerImage wasn't explicitly set, use the
	// official image. When useNightlyImage is true, use the nightly tag;
	// otherwise use the versioned tag.
	if (finalConfig.buildImage === false && userConfig.dockerImage === undefined) {
		if (finalConfig.useNightlyImage) {
			finalConfig.dockerImage = 'ghcr.io/yanranxiaoxi/claude-code-runner:nightly';
		}
		else {
			finalConfig.dockerImage = 'ghcr.io/yanranxiaoxi/claude-code-runner:v__PACKAGE_VERSION__';
		}
	}

	return finalConfig;
}

export async function saveConfig(
	config: SandboxConfig,
	configPath: string,
): Promise<void> {
	const fullPath = path.resolve(configPath);
	await fs.writeFile(fullPath, JSON.stringify(config, null, 2));
}
