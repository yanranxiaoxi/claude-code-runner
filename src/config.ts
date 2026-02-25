import type { CodeRunner, SandboxConfig } from './types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CONFIG: SandboxConfig = {
	dockerImage: 'claude-code-runner:latest',
	buildImage: true, // Build locally by default, set to false to pull from registry
	autoPush: true,
	autoCreatePR: true,
	autoStartClaude: true,
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
	try {
		const fullPath = path.resolve(configPath);
		const configContent = await fs.readFile(fullPath, 'utf-8');
		const userConfig = JSON.parse(configContent);

		// Merge with defaults
		const finalConfig = {
			...DEFAULT_CONFIG,
			...userConfig,
		};

		// Resolve code runner for backward compatibility
		finalConfig.codeRunner = resolveCodeRunner(finalConfig);

		// Sync defaultShell with codeRunner if not explicitly set to 'bash'
		if (finalConfig.defaultShell !== 'bash') {
			finalConfig.defaultShell = finalConfig.codeRunner;
		}

		// If buildImage is false and dockerImage wasn't explicitly set, use official image
		if (finalConfig.buildImage === false && userConfig.dockerImage === undefined) {
			finalConfig.dockerImage = 'ghcr.io/yanranxiaoxi/claude-code-runner:latest';
		}

		return finalConfig;
	}
	catch (error) {
		// Config file not found or invalid, use defaults
		return DEFAULT_CONFIG;
	}
}

export async function saveConfig(
	config: SandboxConfig,
	configPath: string,
): Promise<void> {
	const fullPath = path.resolve(configPath);
	await fs.writeFile(fullPath, JSON.stringify(config, null, 2));
}
