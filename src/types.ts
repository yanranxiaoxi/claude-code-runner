// Supported code runners
export type CodeRunner = 'claude' | 'opencode';

// Code runner configuration
export interface CodeRunnerConfig {
	name: string;
	displayName: string;
	command: string;
	dangerousFlag: string;
	installMethod: 'script' | 'npm';
	installCommand: string;
	pathSetup: string;
	configPath?: string;
}

// Registry of supported code runners
export const CODE_RUNNERS: Record<CodeRunner, CodeRunnerConfig> = {
	claude: {
		name: 'claude',
		displayName: 'Claude Code',
		command: 'claude',
		dangerousFlag: '--dangerously-skip-permissions',
		installMethod: 'script',
		installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
		pathSetup: 'export PATH="$HOME/.local/bin:$PATH"',
		configPath: '.claude.json',
	},
	opencode: {
		name: 'opencode',
		displayName: 'OpenCode',
		command: 'opencode',
		dangerousFlag: '--dangerously-skip-permissions',
		installMethod: 'npm',
		installCommand: 'npm install -g opencode',
		pathSetup: '', // npm global bin is already in PATH
		configPath: 'opencode.json',
	},
};

export interface VolumeMount {
	source: string;
	target: string;
	readonly?: boolean;
}

export interface SandboxConfig {
	dockerImage?: string;
	dockerfile?: string;
	buildImage?: boolean;
	containerPrefix?: string;
	autoPush?: boolean;
	autoCreatePR?: boolean;
	autoStartClaude?: boolean;
	defaultShell?: 'claude' | 'opencode' | 'bash';
	codeRunner?: CodeRunner; // Which code runner to use (claude or opencode)
	claudeConfigPath?: string;
	setupCommands?: string[];
	environment?: Record<string, string>;
	envFile?: string;
	volumes?: string[];
	mounts?: VolumeMount[];
	allowedTools?: string[];
	maxThinkingTokens?: number;
	bashTimeout?: number;
	includeUntracked?: boolean;
	targetBranch?: string;
	remoteBranch?: string;
	prNumber?: string;
	dockerSocketPath?: string;
	skipReconnectCheck?: boolean; // Default: false - check for existing containers
	// SSH/GPG configuration
	forwardSshKeys?: boolean; // Default: true - forward ~/.ssh to container
	forwardGpgKeys?: boolean; // Default: true - forward ~/.gnupg to container
	forwardSshAgent?: boolean; // Default: true - forward SSH_AUTH_SOCK for passphrase-protected keys
	forwardGpgAgent?: boolean; // Default: false - forward GPG agent socket for signing in container
	enableGpgSigning?: boolean; // Default: false - enable GPG commit signing
}

export interface Credentials {
	claude?: {
		type: 'api_key' | 'oauth' | 'bedrock' | 'vertex';
		value: string;
		region?: string;
		project?: string;
	};
	github?: {
		token?: string;
		gitConfig?: string;
	};
}

export interface CommitInfo {
	hash: string;
	author: string;
	date: string;
	message: string;
	files: string[];
}
