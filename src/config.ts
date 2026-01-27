import type { SandboxConfig } from './types';
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
	claudeConfigPath: path.join(os.homedir(), '.claude.json'),
	setupCommands: [], // Example: ["npm install", "pip install -r requirements.txt"]
	allowedTools: ['*'], // All tools allowed in sandbox
	includeUntracked: false, // Don't include untracked files by default
	// maxThinkingTokens: 100000,
	// bashTimeout: 600000, // 10 minutes
};

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

export async function saveConfig(
	config: SandboxConfig,
	configPath: string,
): Promise<void> {
	const fullPath = path.resolve(configPath);
	await fs.writeFile(fullPath, JSON.stringify(config, null, 2));
}
