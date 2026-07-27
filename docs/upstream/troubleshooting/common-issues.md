> Источник: https://cloudcli.ai/docs/troubleshooting/common-issues — официальная документация CloudCLI (upstream, EN). Забрано для последующего перевода/доработки.

# CloudCLI Troubleshooting Guide

## Common Issues

Solutions to the most common problems people run into when installing and running CloudCLI UI.

### No Projects or Sessions Found

**Symptom**: The UI loads but shows no projects or an empty session list.

**Solutions**:

- Make sure Claude Code (or your chosen agent) is installed and has been run at least once in a project directory
- Check that `~/.claude/projects/` exists and has the correct permissions
- Run `claude` in at least one project directory to initialise it, then refresh the UI
- If using a custom `WORKSPACES_ROOT`, verify the path exists and contains project directories

### File Explorer Shows Empty or Returns Permission Error

**Symptom**: Clicking into a project shows no files, or you see a permission error.

**Solutions**:

- Check directory permissions with `ls -la` in your terminal
- Verify the project path is accessible by the user running the CloudCLI UI server
- Check the server console for detailed error messages
- Avoid navigating to system directories outside your project scope

### Port Already in Use

**Symptom**: `Error: listen EADDRINUSE :::3001`

**Solutions**:

```bash
# Start on a different port
cloudcli --port 8080

# Or find and kill what's using 3001
lsof -i :3001
kill -9 <PID>
```

### Windows Installation Errors (node-pty)

**Symptom**: "npm install fails with errors related to node-pty or winpty on Windows (not WSL)."

**Solutions**:

- Use WSL (Windows Subsystem for Linux) instead of running natively on Windows
- If you must use Windows natively, install the Windows Build Tools: `npm install -g windows-build-tools`
- Make sure Visual Studio Build Tools are installed

### MCP Server Not Connecting

**Symptom**: An MCP server shows as disconnected or tools are missing.

**Solutions**:

- Verify the command and arguments are correct
- Check that required environment variables are set
- Run `claude mcp list` in your terminal to confirm the server is registered
- "MCP servers are initialised at session start, not dynamically"

### Still Stuck?

- Check open issues on [GitHub](https://github.com/siteboon/claudecodeui/issues)
- Ask in the [Discord community](https://discord.gg/buxwujPNRE)
- Open a new issue if your problem isn't already reported

---

*Last updated April 24, 2026*
