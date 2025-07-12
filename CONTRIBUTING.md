# Contributing to TurboLogger

We love your input! We want to make contributing to TurboLogger as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features
- Becoming a maintainer

## We Develop with GitHub

We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

## We Use [GitHub Flow](https://guides.github.com/introduction/flow/index.html)

Pull requests are the best way to propose changes to the codebase. We actively welcome your pull requests:

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs, update the documentation.
4. Ensure the test suite passes.
5. Make sure your code lints.
6. Issue that pull request!

## Any contributions you make will be under the MIT Software License

In short, when you submit code changes, your submissions are understood to be under the same [MIT License](http://choosealicense.com/licenses/mit/) that covers the project. Feel free to contact the maintainers if that's a concern.

## Report bugs using GitHub's [issues](https://github.com/TurboLogger/TurboLogger/issues)

We use GitHub issues to track public bugs. Report a bug by [opening a new issue](https://github.com/TurboLogger/TurboLogger/issues/new); it's that easy!

## Write bug reports with detail, background, and sample code

**Great Bug Reports** tend to have:

- A quick summary and/or background
- Steps to reproduce
  - Be specific!
  - Give sample code if you can
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

## Development Process

### Prerequisites

- Node.js >= 14.0.0
- npm or yarn
- TypeScript knowledge

### Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/TurboLogger/TurboLogger.git
   cd TurboLogger
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

4. Run tests:
   ```bash
   npm test
   ```

### Development Workflow

1. Create a new branch for your feature/fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure:
   - Code follows the existing style
   - Tests pass (`npm test`)
   - Linting passes (`npm run lint`)
   - TypeScript compiles without errors (`npm run typecheck`)

3. Add tests for any new functionality

4. Update documentation if needed

5. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "feat: add new transport for Redis"
   git commit -m "fix: resolve memory leak in buffer management"
   git commit -m "docs: update API documentation"
   ```

### Code Style

- We use ESLint and Prettier for code formatting
- Run `npm run format` to auto-format your code
- Run `npm run lint` to check for linting errors
- TypeScript strict mode is enabled - ensure no type errors

### Testing

- Write tests for all new features
- Maintain or improve code coverage
- Run `npm run test:coverage` to check coverage
- Tests should be:
  - Isolated
  - Reproducible
  - Fast
  - Clear in their intent

### Performance

TurboLogger is built for performance. When contributing:

- Benchmark your changes if they affect core logging paths
- Use the benchmark suite: `npm run benchmark`
- Avoid unnecessary allocations
- Consider using object pooling for frequently created objects
- Profile memory usage for long-running operations

## Pull Request Guidelines

1. **Title**: Use a clear and descriptive title
2. **Description**: Explain what changes you've made and why
3. **Testing**: Describe how you've tested your changes
4. **Screenshots**: Include screenshots for UI changes
5. **Breaking Changes**: Clearly mark any breaking changes

## Community

- GitHub Issues: https://github.com/TurboLogger/TurboLogger/issues
- Email: ersinkoc@gmail.com

## License

By contributing, you agree that your contributions will be licensed under its MIT License.

## References

This document was adapted from the open-source contribution guidelines for [Facebook's Draft](https://github.com/facebook/draft-js/blob/a9316a723f9e918afde44dea68b5f9f39b7d9b00/CONTRIBUTING.md)