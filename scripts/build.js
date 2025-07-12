#!/usr/bin/env node

/**
 * Cross-platform build script for TurboLogger
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Helper functions
function run(command, options = {}) {
  console.log(`🔧 Running: ${command}`);
  try {
    execSync(command, { stdio: 'inherit', ...options });
  } catch (error) {
    console.error(`❌ Command failed: ${command}`);
    process.exit(1);
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) {
    console.log(`🗑️  Removing ${dir}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`📁 Creating ${dir}`);
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Build commands
const commands = {
  clean() {
    console.log('🧹 Cleaning build artifacts...');
    removeDir('lib');
    removeDir('types');
    removeDir('coverage');
    console.log('✅ Clean complete');
  },

  compile() {
    console.log('🔨 Compiling TypeScript...');
    run('npx tsc src/index.ts src/simple-logger.ts --outDir lib --declaration --declarationDir types --target es2020 --module commonjs --moduleResolution node --strict false');
    console.log('✅ CommonJS compilation complete');
  },

  compileEsm() {
    console.log('🔨 Skipping ESM compilation (CommonJS only for now)...');
    console.log('✅ ESM compilation skipped');
  },

  postBuild() {
    console.log('📦 Running post-build tasks...');
    // ESM package.json files creation
    this.createEsmPackages();
    console.log('✅ Post-build complete');
  },

  createEsmPackages() {
    const fs = require('fs');
    const path = require('path');
    
    // Create ESM package.json files
    const esmPackageContent = '{"type": "module"}\n';
    const esmDirs = [
      'lib/esm',
      'lib/esm/core',
      'lib/esm/transports',
      'lib/esm/integrations'
    ];
    
    esmDirs.forEach(dir => {
      const fullPath = path.join(process.cwd(), dir);
      if (fs.existsSync(fullPath)) {
        fs.writeFileSync(path.join(fullPath, 'package.json'), esmPackageContent);
      }
    });
  },

  test() {
    console.log('🧪 Running tests...');
    run('node scripts/test-runner.js');
    console.log('✅ Tests complete');
  },

  lint() {
    console.log('🔍 Running linter...');
    run('npx eslint src/index.ts src/simple-logger.ts');
    console.log('✅ Linting complete');
  },

  format() {
    console.log('💄 Formatting code...');
    run('npx prettier --write "src/**/*.ts"');
    console.log('✅ Formatting complete');
  },

  typecheck() {
    console.log('🔎 Type checking...');
    run('npx tsc src/index.ts src/simple-logger.ts --noEmit --strict false');
    console.log('✅ Type checking complete');
  },

  build() {
    this.clean();
    this.lint();
    this.typecheck();
    this.compile();
    this.compileEsm();
    this.postBuild();
    console.log('🎉 Build complete!');
  },

  dev() {
    this.clean();
    this.compile();
    this.compileEsm();
    this.postBuild();
    console.log('🚀 Development build complete!');
  },

  prod() {
    this.build();
    console.log('🎉 Production build complete!');
  },

  watch() {
    console.log('👀 Starting watch mode...');
    run('npx tsc --watch');
  },

  validate() {
    this.lint();
    this.typecheck();
    this.test();
    console.log('✅ Validation complete');
  }
};

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'build';

if (commands[command]) {
  commands[command]();
} else {
  console.error(`❌ Unknown command: ${command}`);
  console.log('Available commands:', Object.keys(commands).join(', '));
  process.exit(1);
}
