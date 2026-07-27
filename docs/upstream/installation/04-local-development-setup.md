> Источник: https://cloudcli.ai/docs/installation/local-development-setup — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Local Development Setup — CloudCLI UI

## Overview

This guide enables contributors to run CloudCLI UI locally with hot reload functionality. It's designed for those wanting to contribute, build extensions, or access the latest unreleased features.

## Prerequisites

Before starting, review the Prerequisites documentation.

## Clone the Repository

```bash
git clone https://github.com/siteboon/claudecodeui.git
cd claudecodeui
```

## Install Dependencies

```bash
npm install
```

## Configure Environment

```bash
cp .env.example .env
```

Edit the `.env` file to specify your preferred port and other configuration options.

## Start in Development Mode

```bash
npm run dev
```

The application launches with hot reload at the port defined in `.env` (default: `http://localhost:3001`).

Running from the repository ensures access to the most current changes, including unreleased features and bug fixes. To stay updated:

```bash
git pull origin main
npm install
```

## Contributing

Review the [Contributing Guide](https://github.com/siteboon/claudecodeui/blob/main/CONTRIBUTING.md) for details on commit conventions, branch naming standards, and the pull request workflow.

---

**Last updated:** April 24, 2026
