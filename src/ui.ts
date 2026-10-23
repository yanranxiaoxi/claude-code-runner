import type { CommitInfo, WorkspaceMode } from './types';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

export class UIManager {
	showCommitNotification(commit: CommitInfo): void {
		console.log(`\n${chalk.yellow('━'.repeat(80))}`);
		console.log(chalk.yellow.bold('🔔 New Commit Detected!'));
		console.log(chalk.yellow('━'.repeat(80)));
		console.log(chalk.white(`Hash: ${commit.hash.substring(0, 8)}`));
		console.log(chalk.white(`Author: ${commit.author}`));
		console.log(chalk.white(`Date: ${commit.date}`));
		console.log(chalk.white(`Message: ${commit.message}`));
		console.log(chalk.white(`Files changed: ${commit.files.length}`));
		commit.files.forEach((file) => {
			console.log(chalk.gray(`  - ${file}`));
		});
		console.log(`${chalk.yellow('━'.repeat(80))}\n`);
	}

	showDiff(diff: string): void {
		console.log(chalk.blue.bold('\n📝 Diff:'));
		console.log(chalk.blue('─'.repeat(80)));

		// Apply syntax highlighting to diff
		const lines = diff.split('\n');
		lines.forEach((line) => {
			if (line.startsWith('+') && !line.startsWith('+++')) {
				console.log(chalk.green(line));
			}
			else if (line.startsWith('-') && !line.startsWith('---')) {
				console.log(chalk.red(line));
			}
			else if (line.startsWith('@@')) {
				console.log(chalk.cyan(line));
			}
			else if (line.startsWith('diff --git')) {
				console.log(chalk.yellow.bold(line));
			}
			else {
				console.log(line);
			}
		});

		console.log(`${chalk.blue('─'.repeat(80))}\n`);
	}

	async askCommitAction(): Promise<string> {
		const { action } = await inquirer.prompt([
			{
				type: 'list',
				name: 'action',
				message: 'What would you like to do?',
				choices: [
					{ name: 'Continue working', value: 'nothing' },
					{ name: 'Push branch to remote', value: 'push' },
					{ name: 'Push branch and create PR', value: 'push-pr' },
					{ name: 'Exit claude-code-runner', value: 'exit' },
				],
			},
		]);

		return action;
	}

	async askWorkspaceMode(): Promise<WorkspaceMode> {
		console.log('');
		console.log(chalk.cyan.bold('Workspace mode'));
		console.log(chalk.gray('  Shadow (recommended): copy files into an isolated Git shadow workspace.'));
		console.log(chalk.gray('                        Your host directory is not mounted.'));
		console.log(chalk.gray('  Direct:               mount the current directory read-write into the container.'));
		console.log(chalk.gray('                        Edits apply immediately and there is no snapshot/rollback.'));
		console.log(chalk.yellow('  Direct mode exposes all files in the directory, including ignored files and secrets.'));
		console.log('');

		const { mode } = await inquirer.prompt([
			{
				type: 'list',
				name: 'mode',
				message: 'Choose workspace mode:',
				choices: [
					{
						name: 'Shadow workspace (recommended) - host directory stays untouched',
						value: 'shadow',
						short: 'Shadow',
					},
					{
						name: 'Direct workspace - mount current directory read-write (no rollback)',
						value: 'direct',
						short: 'Direct',
					},
				],
				default: 'shadow',
			},
		]);

		return mode as WorkspaceMode;
	}

	showDirectModeWarning(workDir: string): void {
		console.log('');
		console.log(chalk.yellow.bold('⚠ Direct workspace mode'));
		console.log(chalk.white(`  Source: ${workDir}`));
		console.log(chalk.white('  Target: /workspace (read-write)'));
		console.log(chalk.gray('  - All files, including ignored files and secrets, are visible to the container.'));
		console.log(chalk.gray('  - Changes are applied immediately; this tool does not create snapshots or backups.'));
		console.log(chalk.gray('    Commit/stash or back up important work before continuing.'));
		console.log(chalk.gray('  - Branch/PR options are disabled and Git is restricted to read-only operations.'));
		console.log(chalk.gray('  - setupCommands run only after explicit confirmation.'));
		console.log(chalk.gray('  - Additional volumes/mounts in the config may expose more host paths.'));
		console.log('');
	}

	async confirmDirectSetupCommands(workDir: string, commands: string[]): Promise<boolean> {
		console.log('');
		console.log(chalk.yellow.bold('⚠ Direct workspace mode: setupCommands require confirmation'));
		console.log(chalk.white(`  Working directory: ${workDir}`));
		console.log(chalk.gray('  These commands will run in your host directory, not in an isolated copy:'));
		commands.forEach((command, index) => {
			console.log(chalk.gray(`    ${index + 1}. ${command}`));
		});
		console.log(chalk.gray('  They are not sandboxed and may modify or delete files.'));
		console.log(chalk.gray('  Git is restricted to read-only operations in direct mode.'));
		console.log('');

		const { approved } = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'approved',
				message: 'Run these commands in the host directory?',
				default: false,
			},
		]);

		return approved;
	}

	async askGitInit(): Promise<boolean> {
		console.log('');
		console.log(chalk.yellow('⚠ Not a git repository'));
		console.log(chalk.gray('Claude Code Runner works best with git for tracking changes.'));
		console.log('');

		const { shouldInit } = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'shouldInit',
				message: 'Would you like to initialize a git repository in this directory?',
				default: true,
			},
		]);

		return shouldInit;
	}

	showSpinner(message: string): any {
		return ora(message).start();
	}

	showSuccess(message: string): void {
		console.log(chalk.green(`✓ ${message}`));
	}

	showError(message: string): void {
		console.log(chalk.red(`✗ ${message}`));
	}

	showWarning(message: string): void {
		console.log(chalk.yellow(`⚠ ${message}`));
	}

	showInfo(message: string): void {
		console.log(chalk.blue(`ℹ ${message}`));
	}
}
