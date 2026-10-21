# Customizations and profiles

Use this reference when adding shared skills, MCP servers, or agent personas.
These are files consumed by agents; Termic's MCP tools are a separate
interface for controlling tasks and tabs.

## Find the correct profile folder

In the intended profile's window, open **Settings > Agents & Terminals >
Agent customizations > Open customizations folder**. The action initializes
the folder and displays its exact path. Do not infer it from the task name,
working directory, account name, or profile's display name.

On macOS, let `DATA` stand for the app data directory:

| Build | DATA |
| --- | --- |
| Release | `~/Library/Application Support/termic` |
| Development | `~/Library/Application Support/termic_dev` |

| Profile identity | Customizations folder |
| --- | --- |
| Root, including an install with no named profiles | `DATA/customizations` |
| Additional profile | `DATA/profiles/<slug>/customizations` |

The root profile intentionally stays at the original location, preserving
existing installations. Naming or renaming that profile does not move it.
Additional profiles have a slug fixed at creation; changing the display
name does not change the slug or path. Each has separate customizations and
a separate default. Other operating systems use their platform app data
directory. Debug builds may use a test data-directory override, so prefer
the folder action's returned path over a hardcoded location.

## Inheritance and ownership

**Use profile customizations by default** controls all projects using
**Use profile default**, including existing projects without an explicit
choice. Projects can explicitly always inherit, use project files only,
or disable profile customizations. These explicit choices survive changes
to the profile default. A disabled default suppresses profile files while
preserving project-owned files.

Termic links skills and generates provider-specific agent/MCP configuration
in tasks. Existing project-owned files take precedence. Change the source
in the profile folder for shared behavior, or the project's own files for
project-specific behavior. Restart agents after changes so native config,
environment values, and sandbox access agree. Do not move folders or edit
Termic's internal settings/registry JSON to change profiles.

## Skills

Create a directory per skill with a `SKILL.md` entrypoint, for example
`skills/review-api/SKILL.md`:

```markdown
---
name: review-api
description: Review API changes for compatibility and error handling.
---

# Review an API change

Check changed endpoints against existing callers. Report concrete breaking
changes with file and line evidence. Use the repository's test commands.
```

Keep optional `references/`, `scripts/`, and `assets/` inside the skill's
directory and link relevant resources from `SKILL.md`. Termic syndicates
the directory into `.agents/skills/` and `.claude/skills/`; discovery and
optional metadata support still depend on the receiving agent. Skills
provide instructions, not a portable model-selection field.

## Agent personas and models

Create `agents/api-reviewer.md`:

```markdown
---
description: Review API changes for compatibility and authorization errors.
model_tier: reasoning
---

Review the assigned API diff. Prioritize reproducible regressions and
include file and line evidence. Follow the user's scope for edits.
```

The filename supplies the persona name. Use unquoted `model_tier` values:

| Tier | Meaning |
| --- | --- |
| `inherit` | No model override from Termic; provider defaults apply |
| `fast` | Economical, low latency model mapping |
| `balanced` | General coding model mapping |
| `reasoning` | Deeper reasoning model mapping |

Termic currently translates tiers for Claude, Codex, and Antigravity
(`agy`); unknown providers get no model override. Claude Markdown and
Codex TOML personas are generated from this source. Whether and how the
provider invokes the persona is provider-specific; a persona does not
itself create a Termic task or tab.

Native definitions are generated at `.claude/agents/<name>.md`,
`.codex/agents/<name>.toml`, and `.agents/agents/<name>/agent.md` (Antigravity).
Antigravity does not discover `.agents/subagents/`. Its fast and balanced
persona tiers map to `flash`, and its reasoning tier to `pro`.

Do not use `/agents` as a universal definition-list check. Antigravity
includes custom definitions there; Codex uses it to browse chats, and
recent Claude versions show file-editing guidance rather than an agent
library. Restart after first creating native agent directories and use
the provider's actual discovery or validation mechanism.

Tier mappings are fixed by the installed Termic build, not a dynamic model
catalog. They may not match the models available to an account. Do not put
an arbitrary model ID in `model_tier` or assume `model:` passes one through:
the persona parser interprets `model`, `tier`, and `model_tier` as tier
aliases, and unknown values resolve to `inherit`.

For an exact model on a new task or tab, use CLI `--model <model-id>` or
MCP `model`, with provider-specific reasoning options in repeated CLI
`--arg` values or MCP `args`. This launch configuration is independent of
persona tiers. Follow the user's specified model; do not silently replace
an unavailable one. See the launch examples in `../SKILL.md`.

## MCP server definitions

Create `mcp/mcp.json` as JSON, without comments. Its top-level object must
contain `mcpServers`. A stdio server uses `command`, `args`, and `env`;
an HTTP server uses `url` and, when needed, `headers`:

```json
{
  "mcpServers": {
    "local-helper": {
      "command": "/absolute/path/to/helper",
      "args": ["--stdio"],
      "env": {
        "HELPER_API_KEY": "${HELPER_API_KEY}",
        "LOG_LEVEL": "info"
      }
    },
    "remote-helper": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "${REMOTE_AUTHORIZATION}"
      }
    }
  }
}
```

Replace the synthetic command and URL with the intended server. These
definitions connect external MCP servers to agents; they do not register
new tools in Termic's own control server.

Claude consumes `.mcp.json`, Codex consumes `mcp_servers` in
`.codex/config.toml`, and Antigravity consumes `.agents/mcp_config.json`.
Termic translates `url` to Antigravity's `serverUrl` field. Project-owned
files take precedence; the existence of a server already configured
globally is not evidence that profile syndication worked. Check discovery
with a uniquely named fixture in a disposable profile, and distinguish
being listed from successful authentication and actual tool access.

Put local credentials in `mcp/mcp.env.local`, using `KEY=value` lines:

```dotenv
HELPER_API_KEY=synthetic-placeholder
REMOTE_AUTHORIZATION=Bearer synthetic-placeholder
```

Use whole-value `${VARIABLE}` references. In the HTTP example, the variable
contains the entire header value, including `Bearer `; do not assume that
`Bearer ${TOKEN}` or placeholders inside command arguments/URLs expand.
Termic maps Codex stdio references to native `env_vars` and header references
to native `env_http_headers`. Other agents consume their native MCP format;
verify support with that agent. Termic does not validate every provider's
transport, authentication, or optional configuration field.

Use distinct variable names for distinct credentials. Conflicting renamed
stdio aliases across servers, such as two different source secrets both
mapped to `API_KEY`, cannot coexist in the shared task process environment.
Termic omits the ambiguous alias and disables affected generated Codex
servers. Prefer `SERVICE_A_KEY` and `SERVICE_B_KEY` as both source and
destination names. Ordinary literal values remain server-scoped in Codex.

Customization files participate in profile config sync; `mcp.env.local`
does not. Keep secrets in that local file, never in skill prose, persona
instructions, command arguments, URLs, or literal MCP configuration values.
Export sanitization is not a substitute for declaring secrets correctly.

The bundled `skills/termic/` skill and its references update when unedited;
user changes are preserved per file. A customized entrypoint may therefore
retain older instructions after an app update.
