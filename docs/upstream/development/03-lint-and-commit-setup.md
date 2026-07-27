> Источник: https://cloudcli.ai/docs/cloudcli-development-resources/lint-and-commit-setup — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Lint & Commit Setup — CloudCLI UI

## Brief Overview of Git Hooks

Git hooks are automation scripts triggered by specific events in a repository. They use `pre-` or `post-` prefixes to indicate timing—examples include `pre-commit`, `commit-msg`, `pre-push`, and `post-receive`. By default, hooks live in the `.git/hooks` directory, though they can be activated by removing the `.sample` extension.

## How Husky Works

Husky manages git hooks through a streamlined process. Running `npm run prepare` executes `husky install`, which establishes a `.husky` directory and configures Git to search for hooks there instead of `.git/hooks`. Custom hooks can override defaults by creating files with matching names in `.husky`.

The execution flow follows this pattern:
- Git detects a hook trigger (e.g., `pre-commit`)
- Git locates hooks in the configured `.husky/_` directory
- Git executes the hook, which delegates to Husky's helper script
- Husky runs your actual custom script

## How Committing Works in This Project

The project implements a two-stage validation approach:

**Pre-commit stage:** "lint-staged" runs eslint on staged JavaScript and TypeScript files, configured in `package.json`. Linting failures block the commit.

**Commit-message stage:** "commitlint" validates messages against conventional commit format rules defined in `commitlint.config.js`. Messages must include type, optional scope, and description. Non-compliant messages are rejected.

If all checks pass, the commit succeeds.
