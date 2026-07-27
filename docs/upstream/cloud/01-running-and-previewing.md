> Источник: https://cloudcli.ai/docs/cloud/running-and-previewing-your-app — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# Running and Previewing Your App in CloudCLI Cloud

## Overview
CloudCLI Cloud provides bare-bones containerized environments where developers install only necessary dependencies. The `devuser` account includes full sudo access for complete stack customization.

## Installing Software

Package installation uses Ubuntu's `apt` package manager:

```bash
# Node.js
sudo apt update && apt install -y nodejs npm

# Python
sudo apt update && apt install -y python3 python3-pip
```

Any stack requirement—Ruby, Go, Java, etc.—can be installed this way, or delegated to an AI coding agent during project setup.

## Starting a Dev Server

Launch servers with stack-specific commands:

```bash
# Node.js / Express / Next.js
npm run dev

# Python / Flask
python3 -m flask run --host=0.0.0.0 --port=8000

# Python / Django
python3 manage.py runserver 0.0.0.0:8000
```

**Critical requirement:** Bind servers to `0.0.0.0` rather than `localhost` to enable port forwarding accessibility.

## Browser Preview Methods

### VS Code Remote-SSH (Recommended)
The Remote-SSH extension automatically detects open ports and enables forwarding. VS Code displays notifications offering browser access, loading your app on `localhost:8000`. The Ports panel (`Ctrl+Shift+P`) displays all forwarded ports.

### Terminal SSH
For standard SSH sessions, use manual port forwarding:

```bash
ssh -L 8000:localhost:8000 devuser@your-session-host
```

Then navigate to `http://localhost:8000`.

## Key Tips

- Request AI agents to manage installation, database configuration, and server startup
- Verify servers bind to `0.0.0.0` if apps fail appearing after forwarding
