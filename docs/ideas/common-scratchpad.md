# Future work: global and project-scoped common scratchpads

Not approved, idea phase. Captured after exploring persistent cross-task
and cross-project working memory for human users and parallel coding
agents.

## The problem

Termic isolates every agent task in its own git worktree with an embedded
terminal. This keeps code branches clean and avoids concurrent working-tree
file collisions. However, it creates a severe barrier for knowledge sharing:

1. **Task scratchpads (GH #244) are isolated and ephemeral.** They live in
   `<data_dir>/scratch/<taskId>/`. When a task is archived or closed, those
   notes are inaccessible or purged unless manually promoted into the
   worktree.
2. **Project docs (`docs/ideas/`, `docs/plans/`) have a high bar.** They are
   committed to git, subject to strict repo policies (see CLAUDE.md), and
   pollute feature branches if used for temporary scratch notes, raw benchmark
   outputs, or exploratory brainstorms.
3. **Cross-task agent handoffs have no shared scratch surface.** When an
   agent in one task finishes an investigation (e.g. backend schema design)
   and another agent in a parallel task needs to consume it, there is no
   clean place to leave working notes without committing half-baked files to
   git.

## The proposal

Introduce two persistent scratchpad scopes alongside the existing task pads:

* **Global Scratchpad:** User/machine-wide, accessible across all projects
  and tasks. For universal prompt templates, personal cheatsheets, tool
  notes, and cross-project ideas.
* **Project Scratchpad:** Project-scoped, shared across all tasks and
  worktrees of that repository. For architectural notes, cross-agent
  handoffs, spike findings, and sprint scratchpads.

Both scopes are backed by Markdown files, stored outside the code worktrees,
and synchronized across machines using Termic's existing Git config sync
engine (`config_sync.rs`).

## The three-tier model

```
Scope      Lifetime       Storage Location                     Use Cases
─────────────────────────────────────────────────────────────────────────────
Task       Ephemeral      <data_dir>/scratch/<taskId>/         Local run logs,
(existing) (with task)                                         single-task notes

Project    Persistent     <sync_dir>/scratchpads/              Cross-worktree notes,
(new)                     projects/<project_slug>/             architecture spikes,
                                                               agent handoffs

Global     Persistent     <sync_dir>/scratchpads/global/       Reusable prompts,
(new)                                                          cheatsheets, universal
                                                               thoughts
```

## Storage and Git sync

### Layout in the sync repository

When Git sync is connected (`Settings > Sync`), the sync repo gains a
`scratchpads/` root alongside `profiles/` and `prefs.json`:

```
<sync_repo>/
├── prefs.json
├── profiles/
│   └── <profile_slug>/
└── scratchpads/
    ├── global/
    │   ├── index.json
    │   ├── snippets.md
    │   └── ideas.md
    └── projects/
        └── <project_slug>/
            ├── index.json
            ├── roadmap-notes.md
            └── investigations/
                └── mem-leak-2026-10.md
```

### Local-first storage

When Git sync is disconnected or dormant, the exact same directory layout
is maintained under `<data_dir>/scratchpads/`. Connecting sync seeds the
remote repo from local pads; subsequent sync operations export, commit,
fetch, rebase, and push via the existing `config_sync.rs` loop.

### Why discrete Markdown files

1. **Git merge safety:** Separate `.md` files avoid conflicts when multiple
   agents or machines edit different notes simultaneously.
2. **Standard tooling:** Files can be read by `cat`, `grep`, or standard
   editors without parsing a custom database or JSON container.
3. **Frontmatter metadata:** Each file optionally begins with YAML frontmatter
   (`id`, `title`, `updated_at`, `tags`, `pinned`), while the body remains
   pure Markdown.

## Human UI surfaces

1. **Sidebar navigation:**
   * A `Scratchpad` item in each project's sidebar header, opening the
     project-scoped notes list.
   * A global `Scratchpad` section in the sidebar footer/utility area.
2. **Editor & Preview:**
   * Uses Termic's existing CodeMirror 6 editor and `MarkdownPane.tsx`.
   * Scope badges on tabs: `[T]` Task, `[P]` Project, `[G]` Global.
3. **Promotion workflow:**
   * A "Promote to Project Doc" action in the note header that formats the
     note and creates `docs/ideas/<slug>.md` in the main git checkout.

## Agent CLI and MCP interface

Agents running inside any worktree or sandbox can query and write common
scratchpads without leaving their task or touching git:

```sh
# List pads
termic scratchpad list --project
termic scratchpad list --global

# Create or write
termic scratchpad new "auth-spike" --project -c "Initial findings..."
cargo test 2>&1 | termic scratchpad write "auth-spike" --project --append

# Read
termic scratchpad read "auth-spike" --project
```

The MCP server exposes matching tools (`scratchpad_read`, `scratchpad_write`,
`scratchpad_list`, `scratchpad_new`) with a `scope` argument defaulting to
the task if omitted.

## Sandbox boundary

Agents running in macOS Seatbelt or Docker sandboxes must be granted read/write
access to their project's scratchpad directory (`sandbox_rw_paths`), while
remaining denied access to other projects' scratchpads or global configuration.

## Implementation phases

1. **Phase 1: Local multi-scope pads.** Implement `Scope::Project` and
   `Scope::Global` storage in Rust, extend `termic-cli` and MCP tools, and
   add the UI tabs and sidebar entries.
2. **Phase 2: Git sync integration.** Wire the `scratchpads/` tree into
   `config_sync.rs` exports, commits, pulls, and conflict handling.
3. **Phase 3: Promotion & search.** Add one-click graduation to `docs/ideas/`
   and index common scratchpad content in `SearchEverywhereDialog.tsx`.
