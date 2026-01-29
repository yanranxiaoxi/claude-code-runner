#!/usr/bin/env node

/**
 * Inject package version and name into built files
 * This script replaces placeholders with actual values from package.json
 */

const fs = require('node:fs');
const path = require('node:path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const cliJsPath = path.join(__dirname, '..', 'dist', 'cli.js');

// Read package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const { version, name } = packageJson;

console.log(`Injecting version ${version} and name ${name} into dist/cli.js...`);

// Read the built cli.js
let content = fs.readFileSync(cliJsPath, 'utf-8');

// Replace placeholders
content = content.replace(/__PACKAGE_VERSION__/g, version);
content = content.replace(/__PACKAGE_NAME__/g, name);

// Write back
fs.writeFileSync(cliJsPath, content, 'utf-8');

console.log('✓ Version info injected successfully');
