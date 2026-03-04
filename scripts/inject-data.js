#!/usr/bin/env node

/**
 * Inject package version and name into built files
 * This script replaces placeholders with actual values from package.json
 */

const fs = require('node:fs');
const path = require('node:path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const distDir = path.join(__dirname, '..', 'dist');

// Read package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const { version, name } = packageJson;

console.log(`Injecting version ${version} and name ${name} into dist/*.js...`);

// Recursively find all .js files in the dist directory
function getJsFiles(dir) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...getJsFiles(fullPath));
		}
		else if (entry.name.endsWith('.js')) {
			files.push(fullPath);
		}
	}
	return files;
}

const jsFiles = getJsFiles(distDir);
let injectedCount = 0;

for (const filePath of jsFiles) {
	let content = fs.readFileSync(filePath, 'utf-8');
	if (content.includes('__PACKAGE_VERSION__') || content.includes('__PACKAGE_NAME__')) {
		content = content.replace(/__PACKAGE_VERSION__/g, version);
		content = content.replace(/__PACKAGE_NAME__/g, name);
		fs.writeFileSync(filePath, content, 'utf-8');
		console.log(`  ✓ ${path.relative(distDir, filePath)}`);
		injectedCount++;
	}
}

console.log(`✓ Version info injected into ${injectedCount} file(s) successfully`);
