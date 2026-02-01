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
	defaultShell?: 'claude' | 'bash';
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
