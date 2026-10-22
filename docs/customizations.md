# Agent customizations

Open **Settings → Agents & Terminals → Agent customizations** to manage
shared skills, MCP servers, and agent personas for the current profile.
**Open customizations folder** creates the folder on demand, adds the bundled
Termic skill, and opens it in the system file manager. The exact path appears
below the button. Existing edits to the bundled skill are preserved.
The bundled skill includes linked references for customization formats,
persona models, and CLI/MCP task and tab control. Each bundled file updates
independently when unedited; user-edited files are preserved.

Native adapters are provided for **Claude Code, Codex, and Antigravity**.
Other harnesses have partial compatibility that differs by feature and
version. Launching an agent in Termic does not imply that all its profile
customizations work. See the bundled skill's
[compatibility matrix](../src-tauri/assets/skills/termic/references/compatibility.md)
for all 11 built-in harnesses, format differences, primary sources, and
verification limits. Antigravity's generated files are covered by tests;
live `/agents` discovery remains unverified in the reported session.

## Defaults and project overrides

**Use profile customizations by default** applies to every project whose
**Profile customizations** setting is **Use profile default**, including
existing projects without an explicit choice. The default is on.

A project can always inherit, use project files only, or disable profile
customizations. These explicit choices do not change when the profile default
changes. Existing project files are preserved when profile files are linked.
Restart agents after changing the default or editing customization files so
native configuration, process environment, and sandbox access agree.

The default and project choices participate in config sync. Local secrets do
not. Each profile has its own folder and default.

## Files

```text
customizations/
├── skills/
│   ├── termic/SKILL.md       bundled skill, editable
│   └── example/SKILL.md      your skill and optional supporting files
├── agents/
│   └── example.md           persona instructions and frontmatter
└── mcp/
    ├── mcp.json             MCP server definitions
    └── mcp.env.local        local environment values, excluded from sync
```

Edit these files with your preferred editor. Skills use Markdown with the
agent's supported skill frontmatter. Personas can declare a `description`
and `model_tier` (`inherit`, `fast`, `balanced`, or `reasoning`). MCP definitions
use a top-level `mcpServers` object. Keep credentials in `mcp.env.local` and
reference them from `mcp.json` with `${VARIABLE}`. Conflicting shared aliases
are disabled in generated Codex configuration to prevent mixing credentials.

Customizations are reconciled into tasks when agents start, and when project
inheritance, the profile default, or synced customizations change. A running
agent may need restarting to discover new files or MCP servers.

Removing owned links leaves their targets intact, including Windows
directory symlinks and junctions whose source folder has been deleted.
Export and pruning use the same link-removal rules; deletion failures are
reported so sync can retry.

## Native discovery

The adapters write different files for each CLI:

| CLI | Agent definitions | MCP definitions |
| --- | --- | --- |
| Claude Code | `.claude/agents/<name>.md` | `.mcp.json` |
| Codex | `.codex/agents/<name>.toml` | `.codex/config.toml`, under `mcp_servers` |
| Antigravity | `.agents/agents/<name>/agent.md` | `.agents/mcp_config.json` |

Antigravity's remote MCP field is `serverUrl`; Termic translates the profile
source's `url` to that field. The old `.agents/subagents/` location is not an
Antigravity discovery directory. Previously owned links there are removed
on reconciliation. Generated native files use hash-based ownership so
project files and user edits are preserved. A project-owned Antigravity MCP
file takes precedence as a whole, like Claude's project-owned `.mcp.json`.

`/agents` does not mean the same thing in every CLI. Antigravity lists custom
definitions and running subagents. Codex uses it to browse chats; standalone
custom personas are used when spawning subagents. Recent Claude versions
show file-editing guidance instead of the older interactive agent library.
Use the receiving CLI's discovery/validation commands and restart agents
after creating a native directory for the first time.

To distinguish syndicated MCPs from pre-existing global ones, use a uniquely
named, non-secret fixture entry in a disposable profile. Being listed proves
configuration discovery, not server connectivity, authentication, or tool
access. Native trust and approval rules still apply.

See the native specifications for
[Antigravity agents](https://antigravity.google/docs/cli/commands/agents/),
[Antigravity MCP](https://antigravity.google/docs/mcp),
[Codex custom agents](https://developers.openai.com/codex/subagents), and
[Claude subagents](https://code.claude.com/docs/en/sub-agents).

## Storage

On macOS, the root profile's folder is
`~/Library/Application Support/termic/customizations/`. Additional profiles
use `~/Library/Application Support/termic/profiles/<slug>/customizations/`.
Debug builds use `termic_dev` instead of `termic`, and isolated test builds
can override the data directory. Use the button instead of guessing a path.

The root profile deliberately has no `profiles/<slug>/` component. This keeps
an existing installation in place when profiles are enabled. Naming or
renaming the root profile does not relocate its data. Additional profiles
use slugs fixed at creation; changing their display names does not move
their folders either. The folder action resolves the profile from the
calling window, while task syndication uses the owning project's profile.
