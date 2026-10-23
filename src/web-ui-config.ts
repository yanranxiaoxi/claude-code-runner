import type { SandboxConfig } from './types';
import { isIP } from 'node:net';
import process from 'node:process';
import chalk from 'chalk';
import inquirer from 'inquirer';

export interface WebUiListenAddress {
	host: string;
	port: number;
}

export const DEFAULT_WEB_UI_HOST = '127.0.0.1';
export const DEFAULT_WEB_UI_PORT = 3456;

function normalizeHost(host: string): string {
	let normalized = host.trim().toLowerCase();
	if (normalized.startsWith('[') && normalized.endsWith(']')) {
		normalized = normalized.slice(1, -1);
	}
	return normalized;
}

/**
 * Returns true for localhost and IPv4/IPv6 loopback addresses. Hostnames
 * other than localhost are treated as non-local because they may resolve to
 * an externally reachable address.
 */
export function isLoopbackHost(host: string): boolean {
	const normalized = normalizeHost(host);
	if (normalized === 'localhost') {
		return true;
	}

	const version = isIP(normalized);
	if (version === 4) {
		return normalized.startsWith('127.');
	}

	if (version === 6) {
		return (
			normalized === '::1'
			|| normalized === '0:0:0:0:0:0:0:1'
			|| normalized.startsWith('::ffff:127.')
		);
	}

	return false;
}

/**
 * Build a browser-friendly URL for a listening address. Wildcard binds are
 * mapped to the corresponding loopback address.
 */
export function formatWebUiUrl(host: string, port: number): string {
	let displayHost = normalizeHost(host);
	if (displayHost === '0.0.0.0') {
		displayHost = DEFAULT_WEB_UI_HOST;
	}
	else if (displayHost === '::') {
		displayHost = '::1';
	}

	if (displayHost.includes(':')) {
		return `http://[${displayHost}]:${port}`;
	}

	return `http://${displayHost}:${port}`;
}

function printExposureWarning(host: string, port: number, explicitlyAllowed: boolean): void {
	console.log(chalk.yellow('⚠ WARNING: The Web UI is listening on a non-loopback address.'));
	console.log(chalk.yellow(`  Address: ${host}:${port}`));
	if (explicitlyAllowed) {
		console.log(chalk.yellow('  Remote access is explicitly allowed by webUiAllowRemote.'));
	}
	console.log(chalk.red('  This Web UI has no authentication and no TLS.'));
	console.log(chalk.gray('  Anyone who can reach this address can:'));
	console.log(chalk.gray('    • open a terminal in the container'));
	console.log(chalk.gray('    • run arbitrary commands as the container user'));
	console.log(chalk.gray('    • read, modify, or delete files in the mounted workspace'));
	console.log(chalk.gray('    • access forwarded credentials, SSH keys, and environment variables'));
	console.log(chalk.gray('  The container user also has passwordless sudo.'));
	console.log(chalk.gray('  Only expose this on a trusted network. Prefer an SSH tunnel, VPN, firewall, or authenticated reverse proxy.'));
}

/**
 * Resolve the Web UI listen address. Non-loopback binds require either
 * `webUiAllowRemote: true` in the config or an interactive confirmation.
 * Without a TTY, or when the user declines, fall back to loopback.
 */
export async function resolveWebUiListen(
	config: Pick<SandboxConfig, 'webUiHost' | 'webUiPort' | 'webUiAllowRemote'>,
): Promise<WebUiListenAddress> {
	const configuredHost = config.webUiHost?.trim() || DEFAULT_WEB_UI_HOST;
	const port = config.webUiPort ?? DEFAULT_WEB_UI_PORT;

	if (isLoopbackHost(configuredHost)) {
		return { host: configuredHost, port };
	}

	if (config.webUiAllowRemote === true) {
		printExposureWarning(configuredHost, port, true);
		return { host: configuredHost, port };
	}

	printExposureWarning(configuredHost, port, false);
	console.log(chalk.gray('  Set "webUiAllowRemote": true in claude-run.config.json to skip this prompt.'));

	if (!process.stdin.isTTY) {
		console.log(chalk.yellow('⚠ No TTY available to confirm remote access; falling back to 127.0.0.1.'));
		return { host: DEFAULT_WEB_UI_HOST, port };
	}

	const { allow } = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'allow',
			message: `Allow Web UI to listen on ${configuredHost}:${port}?`,
			default: false,
		},
	]);

	if (!allow) {
		console.log(chalk.yellow('Remote binding was not confirmed; falling back to 127.0.0.1.'));
		return { host: DEFAULT_WEB_UI_HOST, port };
	}

	return { host: configuredHost, port };
}
