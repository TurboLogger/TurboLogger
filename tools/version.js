#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const command = args[0];

const packagePath = path.join(__dirname, '..', 'package.json');
const package = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function getCurrentVersion() {
  return package.version;
}

function bumpVersion(type) {
  const currentVersion = getCurrentVersion();
  const parts = currentVersion.split('.');
  
  switch (type) {
    case 'major':
      parts[0] = String(Number(parts[0]) + 1);
      parts[1] = '0';
      parts[2] = '0';
      break;
    case 'minor':
      parts[1] = String(Number(parts[1]) + 1);
      parts[2] = '0';
      break;
    case 'patch':
      parts[2] = String(Number(parts[2]) + 1);
      break;
    default:
      throw new Error(`Unknown version type: ${type}`);
  }
  
  return parts.join('.');
}

function updateChangelog(version) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  
  const date = new Date().toISOString().split('T')[0];
  const unreleasedSection = `## [Unreleased]`;
  const newVersionSection = `## [${version}] - ${date}`;
  
  // Update the unreleased section
  changelog = changelog.replace(
    unreleasedSection,
    `${unreleasedSection}\n\n${newVersionSection}`
  );
  
  // Update the links at the bottom
  const unreleasedLink = `[Unreleased]: https://github.com/TurboLogger/TurboLogger/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: https://github.com/TurboLogger/TurboLogger/compare/v${getCurrentVersion()}...v${version}`;
  
  changelog = changelog.replace(
    /\[Unreleased\]:.*/,
    `${unreleasedLink}\n${versionLink}`
  );
  
  fs.writeFileSync(changelogPath, changelog);
}

function createGitTag(version) {
  try {
    execSync(`git add -A`, { stdio: 'inherit' });
    execSync(`git commit -m "chore: release v${version}"`, { stdio: 'inherit' });
    execSync(`git tag -a v${version} -m "Release v${version}"`, { stdio: 'inherit' });
    console.log(`Created git tag v${version}`);
  } catch (error) {
    console.error('Failed to create git tag:', error.message);
  }
}

function showHelp() {
  console.log(`
TurboLogger Version Management Tool

Usage: node tools/version.js <command> [options]

Commands:
  current          Show current version
  bump <type>      Bump version (major, minor, patch)
  tag <version>    Create git tag for version
  changelog        Update CHANGELOG.md for current version
  
Examples:
  node tools/version.js current
  node tools/version.js bump patch
  node tools/version.js bump minor
  node tools/version.js bump major
  node tools/version.js tag 1.0.1
  `);
}

// Main execution
switch (command) {
  case 'current':
    console.log(`Current version: ${getCurrentVersion()}`);
    break;
    
  case 'bump':
    const type = args[1];
    if (!['major', 'minor', 'patch'].includes(type)) {
      console.error('Error: bump type must be major, minor, or patch');
      process.exit(1);
    }
    
    const newVersion = bumpVersion(type);
    package.version = newVersion;
    
    // Update package.json
    fs.writeFileSync(packagePath, JSON.stringify(package, null, 2) + '\n');
    
    // Update changelog
    updateChangelog(newVersion);
    
    // Create git tag
    createGitTag(newVersion);
    
    console.log(`Version bumped from ${getCurrentVersion()} to ${newVersion}`);
    break;
    
  case 'tag':
    const version = args[1];
    if (!version) {
      console.error('Error: version required');
      process.exit(1);
    }
    createGitTag(version);
    break;
    
  case 'changelog':
    updateChangelog(getCurrentVersion());
    console.log('Changelog updated');
    break;
    
  case 'help':
  default:
    showHelp();
    break;
}