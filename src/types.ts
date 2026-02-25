// Supported code runners
export type CodeRunner = 'claude' | 'opencode' | 'codex' | 'kimi' | 'qwen';

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
		dangerousFlag: '', // OpenCode has no dangerous mode flag; auto-approval only in non-interactive mode (-p)
		installMethod: 'npm',
		installCommand: 'npm install -g opencode',
		pathSetup: '', // npm global bin is already in PATH
		configPath: 'opencode.json',
	},
	codex: {
		name: 'codex',
		displayName: 'Codex',
		command: 'codex',
		dangerousFlag: '--dangerously-bypass-approvals-and-sandbox',
		installMethod: 'npm',
		installCommand: 'npm install -g @openai/codex',
		pathSetup: '', // npm global bin is already in PATH
		configPath: '.codex',
	},
	kimi: {
		name: 'kimi',
		displayName: 'Kimi Code',
		command: 'kimi',
		dangerousFlag: '--yolo',
		installMethod: 'script',
		installCommand: 'curl -LsSf https://code.kimi.com/install.sh | bash',
		pathSetup: 'export PATH="$HOME/.local/bin:$PATH"',
		configPath: '.kimi',
	},
	qwen: {
		name: 'qwen',
		displayName: 'Qwen Code',
		command: 'qwen',
		dangerousFlag: '--yolo',
		installMethod: 'npm',
		installCommand: 'npm install -g @qwen-code/qwen-code@latest',
		pathSetup: '', // npm global bin is already in PATH
		configPath: '.qwen',
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
	defaultShell?: 'claude' | 'opencode' | 'codex' | 'kimi' | 'qwen' | 'bash';
	codeRunner?: CodeRunner; // Which code runner to use
	claudeConfigPath?: string;
	opencodeConfigPath?: string; // Path to OpenCode config (e.g., ~/.config/opencode/opencode.json)
	codexConfigPath?: string; // Path to Codex config directory (e.g., ~/.codex)
	kimiConfigPath?: string; // Path to Kimi Code config directory (e.g., ~/.kimi)
	qwenConfigPath?: string; // Path to Qwen Code config directory (e.g., ~/.qwen)
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
