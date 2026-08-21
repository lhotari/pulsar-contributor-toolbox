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

Installing skills with [`link-skills-to-claude.sh`](link-skills-to-claude.sh)

```shell
./link-skills-to-claude.sh
```

### Reviewing pull requests

Two skills that work together:

* [`pr-review`](skills/pr-review/) — reviews one PR. Claude Fable and Codex
  `gpt-5.6-sol` review independently, the default model synthesizes and both
  cross-validate the result. Terminal output only; it never posts to GitHub.
* [`pr-review-track`](skills/pr-review-track/) — keeps up with a *backlog* of
  PRs. Tracks every in-progress review under `~/.claude/pr-review-track`,
  works out whether each author actually addressed earlier feedback, and drafts
  the reply, inline comments and review resolution into a markdown file.
  **Nothing reaches GitHub until you set `Status: ready` on line 1** — which is
  also what keeps a human accountable for every review, as the
  [ASF Generative Tooling guidance](https://www.apache.org/legal/generative-tooling.html)
  requires.

```shell
# ranked PRs I have not looked at yet; merlimat first, then ASF members
node ~/.claude/skills/pr-review-track/scripts/prt.mjs latest

# what my in-progress reviews are waiting on
node ~/.claude/skills/pr-review-track/scripts/prt.mjs sync && node ~/.claude/skills/pr-review-track/scripts/prt.mjs board
```

In Claude Code: `/pr-review-track re-review`, `/pr-review-track show-latest`,
`/pr-review-track review latest`, `/pr-review-track cleanup`.

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

### Chrome

[Blog post](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

Adding the mcp server
```
claude mcp add chrome-devtools --scope user -- npx chrome-devtools-mcp@latest --autoConnect
```

Go to chrome://inspect/#remote-debugging to enable.