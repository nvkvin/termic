# Harness compatibility

Read this before assuming a profile customization works in a particular
harness. Checked against Termic's registry and upstream documentation/source
on 2026-10-21. This is a format audit, not runtime certification of installed
versions, accounts, model routing, or authenticated MCP tool use.

Termic has 11 built-in agent entries, listed below. User-added agents and
terminal commands have no implicit compatibility guarantee. Standalone
Gemini CLI is not a current built-in entry.

## Termic adapters versus compatible readers

Termic provides native adapters for **Claude Code, Codex, and Antigravity**.
All three sets of files coexist in an inheriting task so different agent
tabs can share a workspace. Other harnesses may read some of those files,
but Termic has no additional persona model-tier adapters for them.

"Compatible reader" below means upstream documents a reader for a path
Termic already writes. It does not mean it has been tested here. Native
locations are project locations unless otherwise stated.

| Built-in harness | Skills | Persona definitions | MCP configuration |
| --- | --- | --- | --- |
| Claude Code | Adapter: `.claude/skills/<name>/SKILL.md` | Adapter: `.claude/agents/<name>.md` | Adapter: `.mcp.json`, `mcpServers` JSON |
| Codex | Adapter: `.agents/skills/<name>/SKILL.md` | Adapter: `.codex/agents/<name>.toml` | Adapter: `.codex/config.toml`, `mcp_servers` TOML |
| Antigravity | Adapter: `.agents/skills/<name>/SKILL.md` | Adapter: `.agents/agents/<name>/agent.md` | Adapter: `.agents/mcp_config.json`; remote `serverUrl` |
| GitHub Copilot CLI | Compatible readers: `.agents/skills/`, `.claude/skills/` | Compatible reader: `.claude/agents/`; native `.github/agents/` also exists | Compatible reader: root `.mcp.json` in trusted workspaces; user config is `~/.copilot/mcp-config.json` |
| Grok Build | Documents Claude skill compatibility; native `.grok/skills/` | Documents Claude agent compatibility; native `.grok/agents/` | Compatible reader: root `.mcp.json`; native `.grok/config.toml` has `mcp_servers` |
| Pi | Compatible reader: `.agents/skills/` | Extension/package dependent; core does not supply the same persona loader | Extension/package dependent; no Termic MCP adapter |
| oh-my-pi (`omp`) | Compatible skill readers, including Claude conventions | Needs adapter: native `.omp/agents/*.md` and extension/plugin agent roots; bare `.claude/agents/` is not its documented native agent source | Compatible root `.mcp.json` fallback reader and Codex config reader; native `.omp/mcp.json` also exists |
| OpenCode | Compatible readers: `.agents/skills/`, `.claude/skills/` | Needs adapter: `.opencode/agents/*.md` or `agent` settings | Needs adapter: `opencode.json`/JSONC `mcp`; command arrays and `environment` differ |
| Muse Code | Compatible readers: `.agents/skills/` and project Claude/Codex skill directories, subject to trust | Native plugin agent definitions have their own publication/review rules; no Termic persona adapter or established bare-directory compatibility | Compatible reader: root `.mcp.json`; user settings also support `mcpServers`, subject to native trust |
| Cursor CLI | Compatible readers: `.agents/skills/`, `.claude/skills/` | Compatible readers: `.claude/agents/`, `.codex/agents/`; native `.cursor/agents/` | Needs adapter: `.cursor/mcp.json`; environment interpolation uses `${env:NAME}` |
| Devin CLI | Compatible reader: `.claude/skills/` through enabled imports; native `.devin/skills/` | Reads `.agents/agents/`, including directory definitions; native `.devin/agents/`. Antigravity-rendered model values are not a Devin model mapping | Compatible reader: root `.mcp.json` through enabled Claude import; native `.devin/mcp_config.json` |

Antigravity's files are generated, but live `/agents` discovery remains
unverified in the reported session. Passing configuration tests and seeing
folders do not prove that the running harness loaded them.

## Compatibility boundaries

- Skills share `SKILL.md`, but discovery roots, activation, trust, and
  optional frontmatter differ. Instructions inside a portable skill can
  still be specific to one provider.
- Personas differ in model IDs/aliases, effort, tools, permissions, and
  invocation. A compatible path alone is not enough: Devin can read the
  Antigravity output directory, but its model values can mean something
  different. Do not treat these as universal persona definitions.
- MCP standardizes the client/server protocol, not a universal client
  configuration file. Filenames, transport keys, environment bindings,
  OAuth, trust, and approvals differ. Being listed does not establish
  successful authentication or usable tools.
- Compatibility readers can be disabled; project-owned files can take
  precedence. Existing global entries can mask a failed project import.
  Verify using a uniquely named disposable fixture.

Launching a harness in Termic does not certify its customization support.
Use model-free discovery diagnostics when available, then verify model
routing and actual MCP tools separately when the task authorizes activity.

## Primary sources

- Claude Code: [skills](https://code.claude.com/docs/en/skills),
  [personas](https://code.claude.com/docs/en/sub-agents),
  [MCP](https://code.claude.com/docs/en/mcp).
- Codex: [skills](https://developers.openai.com/codex/skills),
  [personas](https://developers.openai.com/codex/subagents),
  [configuration](https://developers.openai.com/codex/config-reference).
- Antigravity: [agent discovery](https://antigravity.google/docs/cli/commands/agents/),
  [MCP](https://antigravity.google/docs/mcp).
- Copilot: [skills](https://docs.github.com/en/copilot/concepts/customizations/agent-skills),
  [persona/MCP readers](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
- Grok Build: [Claude compatibility](https://docs.x.ai/build/features/skills-plugins-marketplaces),
  [MCP](https://docs.x.ai/build/features/mcp-servers).
- Pi: [skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md),
  [core scope](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md),
  [MCP extensions](https://pi.dev/packages?name=mcp).
- oh-my-pi: [configuration](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md),
  [personas](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md),
  [root MCP reader](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/discovery/mcp-json.ts).
- OpenCode: [skills](https://opencode.ai/docs/skills/),
  [personas](https://opencode.ai/docs/agents/),
  [MCP](https://opencode.ai/docs/mcp-servers/).
- Muse Code: [skills](https://meta-models.github.io/muse-code-sdk/next/guides/extend/skills/),
  [native plugins](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/concepts/packages-and-capabilities/),
  [MCP](https://meta-models.github.io/muse-code-sdk/next/guides/extend/mcp-servers/).
- Cursor: [skills](https://cursor.com/docs/skills),
  [personas](https://cursor.com/docs/subagents),
  [MCP](https://cursor.com/docs/mcp).
- Devin: [skill/MCP imports](https://docs.devin.ai/cli/reference/configuration/read-config-from),
  [personas](https://docs.devin.ai/cli/subagents).
