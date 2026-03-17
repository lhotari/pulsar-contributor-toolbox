# Useful Claude Code plugins and MCP servers

Assuming Claude Code and IntelliJ are used

## Claude plugins

Use `/plugin` to interactively install
x
* [Official plugins](https://github.com/anthropics/claude-plugins-official/tree/main/plugins)

github, code-review, code-simplifier and ralph-loop could be useful

## Claude Code settings

Enabling the use of tmux panes for multiple concurrent agents ([agent teams](https://code.claude.com/docs/en/agent-teams)):

```shell
jq '
  .env = ((.env // {}) + {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_SPAWN_BACKEND": "tmux"
  }) |
  .teammateMode = "tmux"
' ~/.claude/settings.json > /tmp/settings.tmp && mv /tmp/settings.tmp ~/.claude/settings.json
```

## Custom skills

Useful for Pulsar development

* [skills directory](skills/)

## MCP servers

### Project architecture and high-level design

* [DeepWiki Remote MCP Server](https://docs.devin.ai/work-with-devin/deepwiki-mcp)
  * Server URL: https://mcp.deepwiki.com/mcp

### For IntelliJ

* [Official MCP Server](https://plugins.jetbrains.com/plugin/26071-mcp-server)

Configuring in UI might not work with Claude Code installed by brew. 

In that case, use the UI to copy the config (Claude Code "Auto Configure" drop down menu option "Copy Config")

```
# paste your config to this variable
JETBRAINS_MCP_CONF='{
  "jetbrains": {
    "url": "http://localhost:64342/sse",
    "type": "sse"
  }
}'
# then add the mcp server
claude mcp add-json --scope user jetbrains "$(echo $JETBRAINS_MCP_CONF | jq -c .jetbrains)"
```

Other JetBrains/IntelliJ MCP servers, possibly useful:
* [IDE Index MCP Server](https://plugins.jetbrains.com/plugin/29174-ide-index-mcp-server)
  * https://github.com/hechtcarmel/jetbrains-index-mcp-plugin
* [Debugger MCP Server](https://plugins.jetbrains.com/plugin/29233-debugger-mcp-server)
  * https://github.com/hechtcarmel/jetbrains-debugger-mcp-plugin

### GitHub

* [GitHub MCP Server](https://github.com/github/github-mcp-server)

Create a classic PAT token with these minimum permissions:

* repo - Repository operations
* read:packages - Docker image access
* read:org - Organization team access

For all functionality, it's necessary to add write permissions.

```
 GITHUB_PAT=<your pat>
claude mcp add-json github '{"type":"http","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer '$GITHUB_PAT'"}}'
```

Claude's /plugin command can also install a GitHub plugin. It seems to include the GitHub MCP server configuration.

### Chrome

[Blog post](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

Adding the mcp server
```
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect
```

Go to chrome://inspect/#remote-debugging to enable.