# Future work: config sync through a git repo

Not approved. Phase 1 is built and on main (#365:
`src-tauri/src/config_sync.rs`, `src/lib/configSync.ts`, Settings >
Sync, behind an Experimental badge), but the maintainer has not
approved the design, so this file stays an idea. "Phase 1 as built" below records the answers that build
chose; everything after it is the proposal as written.

Everything a user sets up in termic (projects, project folders and
their colors, per-project overrides, custom agents, prompts, shortcuts,
prefs) lives on one machine. A second laptop, or a reinstall, starts
from nothing. This file proposes syncing that setup through a private
git repo the user owns, and lists what has to be decided before anyone
builds it.

## Phase 1 as built

The open questions at the end, answered:

1. **Profiles.** One repo for the whole machine, a folder per profile
   (`profiles/<sync-id>/`). A profile is bound to its folder by a
   `sync_id` kept locally in that profile (`Settings.sync`). The first
   profile to connect picks a folder or starts a new one, with a
   preview; every other profile then follows the repo by itself, see
   "Profiles follow the repo" below.
2. **Safety defaults** sync: the app-wide prefs (`defaultYolo`,
   `globalDefaultSandboxKind`, `sandboxBypassPermissions`,
   `sandboxAllowScope`) and a project's `default_yolo`,
   `default_sandbox`, `default_sandbox_mode`, `default_docker`. A change
   to one is never silent: it is highlighted in the first-connect
   preview, and a later pull lists it in the report, keeps it as a
   notice in Settings > Sync until dismissed (per profile, so a profile
   whose window was closed sees it when it opens), and announces it once
   as a toast.
3. **Agent `env`** and `docker_env` never sync, and Settings > Sync
   says so, with what else stays on the machine.
4. **Agent `command`** syncs. There is no fallback to a local value
   when the synced one is not on `PATH`.
5. **Pull cadence.** Manual: one pull on launch (after first paint,
   once per process, whichever window asks first) and "Sync now", which
   exports, commits, fetches, rebases, applies and pushes. No timer and
   no push on change. A pull when the window regains focus came later;
   see "Phase 2".
6. **Transport** is git, not a file export.

Decided while building, not by the questions above:

- **Prefs split by scope.** Keys every window shares (not `scoped()`)
  are machine-wide, so they live in a root `prefs.json`; profile-scoped
  ones live in the profile's folder. Windows share one origin, so the
  window that syncs snapshots, and writes, every bound profile's keys.
  Every sync key reloads live (prefs, prompt library, folder colors);
  of the settings, only `auto_install_hooks` waits for the next launch.
- **Unnamed fields, classified.** Local: `created`,
  `docker_sandbox_enabled` (follows whether Docker is installed here),
  `docker_agent_persist_enabled`, `docker_shared_config_dirs`,
  `cli_enabled`, `mcp_enabled` and the migration markers, an agent's
  `builtin`. Sync: `spotlight_enabled`, `code_intel_auto` (the table's
  "code-intel toggles", though its field comment calls it machine-local
  with respect to `.termic.yaml`), `non_git`, `type`, `members`,
  `worktree_symlink_paths` (repo-relative), an agent's `display_name`,
  `work_done`, `kind`, `extends`, `post_launch_capture` and
  `auto_switch_account`. The `*_SYNC` / `*_LOCAL` lists in
  `config_sync.rs` are the answer per field, and a test fails on a field
  in neither.
- **The order is export, commit, fetch, rebase, apply, push**, the one
  "The loop" describes, for the launch pull too (which commits locally
  and does not push). Committing first is what turns an edit to one
  field on two machines into a conflict instead of a silent overwrite.
  Apply is three-way per field: only fields that changed upstream since
  the last sync are written.
- **Conflicts** are settled without finishing the rebase (where
  `--ours` is upstream): once every conflicting file has a choice,
  upstream's changes are applied to local records, skipping each file
  answered "keep this machine's" entirely, then the clone is reset to
  upstream, re-exported, committed and pushed.
- **A pulled project whose repo is already a project here** under its
  own id is aliased (`Settings.sync.aliases`), never registered twice.
  Matching is: the id, then a registered project with the same remote
  URL and subdir, then a repo under `repos_dir`, else the waiting list.
  Clone into `repos_dir` from that list is not built.
- **Remote URL spelling** in a project file is kept when this machine's
  remote normalizes to the same repo, or two machines with `git@` and
  `https://` remotes rewrite each other's line on every sync.
- **Positions** keep the number a file already holds while it still
  sorts after its predecessor, so removing a project rewrites no other
  file.
- **Multi-repo members** are matched by name (their folder in the task
  wrapper); one that arrives with no local match is placed by remote URL
  under `repos_dir`, or left out.
- **A pulled agent that `extends` a local one** borrows that agent's
  `sandbox_allowed_paths`, which are local, or it could not run caged.
  A custom agent deleted on another machine is deleted here.
- **The repo URL** must be `https://`, `http://`, `ssh://`, `git://`,
  `file://` or `user@host:path`, checked before git runs: git reads
  `ext::` as a command to run and a leading `-` as an option. Network
  git also runs with `ext` and `fd` transports off whatever the user's
  config allows.
- **Commit identity** is fixed in the clone's own config (`termic
  <sync@termic.dev>`), with hooks and signing off there too.
- **Disconnect** unbinds the profile and, once no profile is bound,
  deletes the clone. Nothing is deleted from the repo. While other
  profiles still sync, the disconnected one is remembered as opted out
  (`SyncLocal::opted_out`), or the next sync would upload it again.
- **Profiles follow the repo** (built after phase 1, `adopt_profiles`
  and the pure `plan_adoption`). On every run with at least one
  profile bound, after upstream is integrated and before the push:
  - a repo folder no local profile follows becomes a local profile,
    created with the name and accent in its `profile.json`, closed, and
    filled by a first-connect apply. On an install with profiles
    dormant this turns the feature on, naming the existing install
    after the folder it follows;
  - a local profile that follows nothing is uploaded as a new folder,
    but only on a run that pushes ("Sync now"), never on the launch
    pull: a folder named and left unpushed is a name another machine
    can also take;
  - a folder and an unlinked local profile that share a NAME (ignoring
    case), or a folder named after that profile's slug, are never
    matched or duplicated on a guess. Both wait, and that profile's
    Settings > Sync shows the picker with the folder preselected
    (`SyncStatus::suggested_folder`). Merging two project lists by
    accident is hard to undo;
  - deleting a profile here puts its folder on this machine's ignore
    list (`SyncState::ignored_folders`, written by `profile_delete`
    before the data goes), so it is not recreated. Settings > Sync
    lists ignored folders with "Create here" (`sync_restore_folder`).
  The first-connect preview lists the profiles that will be created
  and uploaded, since connecting one profile now moves the others.
- **A new folder is named after the profile's slug** (`new_folder_id`:
  the root's registry slug, `default` when profiles are dormant, `-2`
  on a clash with a folder already in the repo). It was 12 random hex
  characters. The name is only a name: the binding is still the stored
  `sync_id`, because slugs are minted per machine and can differ. A
  repo made before this keeps its hex folder names and keeps working.
- **`profile.json` holds `name` and `accent`**, and both sync like any
  other field (three-way, applied to the registry; an open window's
  title follows). A dormant install has no name for its one profile, so
  it writes the file only when absent: exporting "Default" on every
  sync renamed the folder another machine had named.
- **A profile created by hand starts unlinked.** `profile_create`
  seeded the new profile's settings from the root's, sync binding
  included, which pointed two profiles at one folder.
- **Scratchpads sync.** Global scratchpad (`scratch/`) syncs machine-wide directly at the repository root alongside custom themes. Profile scratchpads (`profiles/<sync-id>/scratch/`) and project scratchpads (`profiles/<sync-id>/scratch/projects/<project-sync-id>/`) sync per profile alongside their respective project configs, mapping project sync IDs to local IDs. Untitled scratchpad indexes merge non-destructively so active local notes are preserved.
- **Not built:** the public-repo warning through `gh` / `glab`, and
  creating the repo from termic.
- **Known limit:** git merges by line, and sorted keys put related
  fields next to each other (`default_sandbox`, `default_sandbox_mode`),
  so two machines changing ADJACENT fields of one record conflict even
  though the fields differ. The per-file choice handles it; a
  field-level merge from the three versions is the phase 3 idea below.

## The request

Set termic up once, and get the same setup on every machine:

- the project list, with its folders, folder colors and order
- per-project settings (scripts, `files_to_copy`, preview URL, default
  agent, sandbox defaults)
- custom agents and their args
- shortcuts, the prompt library, fonts, themes and the other prefs

A backup comes with it: the repo's history is a record of every change,
and a bad edit can be reverted.

## Why a git repo

- **Nothing new to authenticate.** termic already shells out to `git`
  with the user's own environment (`git_command` in `lib.rs`), so the
  user's SSH keys and credential helper just work. No OAuth client, no
  tokens stored by termic, no server.
- **No new outbound host.** The remote is the user's own, reached by the
  same `git` that already fetches their task branches. termic.dev/local
  publishes `connect-src` as proof the webview only talks to termic.dev,
  and a Google Drive integration would make that claim false even if it
  ran from Rust, where the CSP does not reach.
- **Conflicts are explicit.** Two machines editing the same file get a
  merge git can report, instead of the silent `settings 2.json` copies
  that iCloud Drive and Dropbox make.
- **It works everywhere termic runs**, including the Windows port.

Rejected:

- **Native iCloud or Google Drive APIs.** CloudKit needs Apple
  entitlements, has no Tauri binding, and is Apple-only. Drive needs an
  OAuth client, token storage and Google's app verification. Both add a
  vendor to an app whose pitch is that it is entirely on-device.
- **Pointing the data dir at a cloud folder.** `tasks/` holds this
  machine's worktree paths and port blocks, `logins/` holds credentials,
  and file-sync clients evict and conflict-copy live JSON. Two machines
  writing `projects.json` through one would corrupt it.
- **Manual export/import only.** A reasonable first step, and phase 1
  below is close to it, but it leaves the user to remember to do it.

## What syncs and what never does

The rule of thumb: **anything that names a path, a binary, a port range,
a hardware fact or a credential stays on the machine.** Everything else
is the user's preference and follows them.

That is why two fields that [data-model.md](../data-model.md) both calls
"personal" land on different sides. `preview_browser` is a launch
command, and `open -a "Google Chrome"` is a dead link on Linux. `group`,
or a project's default agent, means the same thing on every machine.

Sync is personal config only. It never reads or writes `.termic.yaml`:
team config already travels with the repo it belongs to.

| Store | Syncs | Stays local |
|---|---|---|
| `projects.json` | `id`, `name`, `group`, position in the list, `base_branch`, scripts and `run_scripts`, `files_to_copy`, `preview_url`, `default_cli`, sandbox, Docker and YOLO defaults (see open question 2), `sandbox_allowed_hosts`, `extra_named_ports`, `on_pr_merge`, PR watch flags, code-intel toggles and settings, members (without paths) | `root_path`, `tasks_path`, `remote` (a remote NAME in this clone), `preview_browser`, `sandbox_rw_paths`, `docker_extra_mounts`, `code_intel_servers`, `code_intel_commands` |
| `settings.json` | `agents` (see below), `file_tree_exclude`, `sandbox_default_allowed_hosts`, Docker rebuild settings, `fetch_before_create`, `close_action`, `tray_enabled`, `auto_install_hooks` | `repos_dir`, `default_tasks_path`, `preview_browser`, `task_port_min` / `task_port_max`, `sandbox_default_rw_paths`, `docker_default_extra_mounts`, `docker_agent_extra_dirs`, `discovery_dismissed` (paths), CLI and MCP install state, `welcomed`, `schema_version` |
| Agents | `id`, name, `command`, `args`, `yolo_args`, icon and color, capabilities, `sandbox_allowed_hosts`, account NAMES, `default_account`, `extends`, `kind` | `adopted_account` (the login that already existed on THIS machine), `disabled` (often hides a CLI not installed here), `sandbox_allowed_paths`, and `env` / `docker_env` (never, see below) |
| `localStorage` | fonts and sizes, editor and terminal themes, theme mode, shortcuts, the prompt library, folder colors, indicators, confirm-before prompts, branch prefix, language, sounds | collapse state, recent tasks, split and panel sizes, last New Task mode, `terminalRenderer` and GPU (hardware), `uiScale` (display), `openWithApp` (an app installed here) |
| `~/.config/termic/themes/` | all of it | |
| Never | | `tasks/`, `scratch/`, `logins/`, `docker-agents/`, `docker-forge/`, the CLI token, window state, `servers/`, `backups/` |

The `localStorage` row is a summary. The per-key answer, including the
keys the table does not name, is `src/lib/prefsRegistry.ts`.

**`Agent.env` and `docker_env` are where people put API keys**, so they
never sync by default. A private repo is still a copy of the secret on a
forge's disk.

## Shape of the sync repo

```
<sync repo>/
  README.md                   written once: what this is, do not hand-edit
  profiles/<sync-id>/
    projects/<project-id>.json
    agents/<agent-id>.json
    settings.json
    prefs.json
    removed.json              tombstones, see "Deletions"
  themes/*.json
```

One file per project and per agent, so two machines that edit different
projects never touch the same file. Every file is written
deterministically: sorted keys, pretty-printed, trailing newline. One
changed field is then one changed line, and git merges two machines'
edits to different fields of one project without help.

`project-id` is the existing `Project.id` UUID. A project's file also
carries what another machine needs to find the repo: the remote URL
(from `git remote get-url`, since `Project.remote` is only a name) and
the path of the project below the repo root, for a project that points
at `packages/app` of a monorepo. Multi-repo members carry the same pair
each.

## The loop

**Where the clone lives.** `global_dir()/sync/`. That is inside the data
dir the Seatbelt profile denies to caged agents as its final rule, and
Docker only mounts named subfolders of the data dir (`docker-agents/`,
`docker-forge/`, `docker-gitfiles/`), never the whole thing. A caged
agent can then neither read the user's setup nor push to their repo, in
either sandbox. A clone anywhere the user picks would lose both
guarantees.

**Commit identity.** Set `user.name` and `user.email` in the clone's own
config, never inherit the global one. A global personal address with
GitHub's "block command line pushes that expose my email" setting fails
every push with `GH007`, and in a background loop nobody sees it.

**Push.** A config write (a project saved, a setting changed, a pref
written) schedules an export about ten seconds later, coalescing a
burst of edits into one commit. The export rewrites the profile's
folder, `git add -A`, commits as "sync from <machine name>", then pulls
(below) and pushes.

**Pull.** On launch, on "Sync now", before every push, and when the
window regains focus if the last pull is older than a few minutes. No
background timer in v1. Phase 1 built the launch pull and "Sync now".
The focus pull is built (see "Phase 2"). A timer is not.

**Every network call is bounded.** `fetch_ref` already carries the
pattern (`GIT_TERMINAL_PROMPT=0`, batch-mode SSH with a short connect
timeout, a wall-clock deadline that kills the child), and its comment
says every network git op must go through it. Push goes through the
plain `git()` helper today, so push and clone would each need a bounded
version. Everything runs off the main thread (`spawn_blocking`), like
the other IO commands.

**Apply is per profile window.** A pull for profile A is applied by A's
window, because half of what it applies is A's `scoped()` localStorage
keys, and Rust cannot write those. Rust owns git and the files; the
window owns localStorage and the store reload. The reverse direction is
the same split: the window hands its prefs snapshot to Rust over IPC
for the export.

A profile with no window open still gets its `projects.json` and
`settings.json` applied by Rust on pull. Its prefs wait in the clone and
apply when a window for that profile next opens.

## Finding a project on another machine

A pulled project that is not registered here needs a local path, and
guessing wrong is worse than asking:

1. The `id` is already registered here: update it in place.
2. A repo under `repos_dir` has the same remote URL (the discovery scan,
   `discover_repos_in`, already walks that folder): register it, with
   the subdirectory applied.
3. Neither: list it under "waiting for a folder", with Locate, Clone
   into `repos_dir`, and Skip. Skip is remembered locally so it stops
   asking. A plain-folder project (`non_git`) has no URL and always
   lands here.

## Deletions

Removing a project is not a sidebar edit. `project_remove` archives every
task under it, which runs archive scripts and deletes worktrees, then
hard-deletes the task records. A removal on one machine must never do
that on another one unasked.

So a removal writes a tombstone (`removed.json`: project id, machine,
time) instead of just deleting the file. Another machine that sees the
tombstone shows "removed on <machine>" with Remove and Keep. Keep clears
the tombstone and publishes the project again, so this machine is not
asked on every pull.

That republished file would then reach the first machine as a project
it does not have. So the removing machine also puts the id on its local
Skip list (the one "Finding a project" already keeps), and it does not
come back there unless the user adds it again.

## Conflicts

The file layout keeps them rare, but two machines can still change the
same field between syncs. v1 does not write conflict markers into JSON:
the rebase is aborted, the local state is kept, and the sync status
names the files in conflict with a choice per file, "keep this
machine's" or "take the other one". A field-level merge from the three
versions git already has (`:1:`, `:2:`, `:3:`) is a later phase, and
may never be needed.

## Setup

Settings gets a Sync section per profile: the remote URL, a "Sync now"
button, the last sync time and the last error. When the user is signed
in to `gh` or `glab` (`forge.rs` already detects both), it can offer to
create a private repo. It warns, loudly, if the repo turns out to be
public.

The first connect has two cases. An empty repo gets this machine's setup
pushed. A non-empty one shows what would change here before applying
anything, because the first pull onto a machine already set up is the
one most likely to surprise.

## Constraints

- **Performance.** Nothing touches a PTY path. A pull that changed
  nothing must write nothing through a store setter and re-render no
  sidebar row ([performance.md](../performance.md), bear trap 8); the
  `selectorFanout` count test is the place to pin that. No sleep-poll
  loops in Rust (bear trap 9).
- **Two realms.** The clone is out of reach of both sandboxes, as above.
  Anything added later that mounts the data dir into a container must
  keep `sync/` out.
- **Fixtures.** The e2e spec drives a local bare repo (`file://`) as the
  remote, and plays the "other machine" by committing into it from the
  spec. No real hostnames or users in any fixture.

## Cost

Measured against the pieces, not a guess at the whole:

- **A prefs registry.** The list exists: `src/lib/prefsRegistry.ts`
  names every localStorage key and runtime-built key family, each
  marked profile-scoped or not and classified sync or local with a
  reason, and `src/lib/prefsRegistry.test.ts` fails on a key in source
  the registry does not list, or a listed key nothing uses. What sync
  still needs is a `setPref` write path that doubles as the change
  signal: about 20 files still write localStorage directly, and routing
  them through one function is the remaining mechanical piece.
- **Field classification in Rust**, for `Project`, `Settings` and
  `Agent`, with a test that serializes each struct and fails on a field
  in neither list. Without it, the next field added to `Project` is
  silently synced or silently dropped.
- **The git loop:** clone, commit, bounded push and pull, rebase and
  abort.
- **Project matching** and the "waiting for a folder" list.
- **Tombstones and the per-file conflict choice.**
- **The Settings section**, en and zh-CN.
- **Tests:** cargo for export determinism, classification and
  tombstones; vitest for apply (the registry has its test already); one
  e2e spec against a bare repo.

Phase 1 is a manual "Sync now" with keep-local on conflict: roughly a
week, most of it the `setPref` write path and the Rust classification
tests.
Phase 2, specified below, is the automatic pull and push. Field-level
merging is phase 3 and optional.

## Open questions

1. **Profiles.** A profile's slug is frozen at creation and can differ
   between machines. Is a profile bound to its sync folder by a
   `sync_id` stored in the profile, chosen at first connect? And is it
   one repo with a folder per profile, as sketched, or one repo per
   profile, so a work profile can sync to a work forge and a personal
   one elsewhere?
2. **Safety defaults.** YOLO and sandbox defaults (the app-wide
   `defaultYolo`, a project's `default_yolo`, the default sandbox mode)
   are preferences by the rule above, but
   [data-model.md](../data-model.md) calls `defaultYolo` machine-level,
   and switching approvals off on a work laptop because of a click on a
   personal one is a bad surprise. Proposed answer: sync them, and show
   any change to one in the preview before it applies.
   `src/lib/prefsRegistry.ts` already classifies them `sync`.
3. **Agent `env`.** Never, opt-in with a warning, or encrypted in the
   repo (age, sops)? Never is the simplest honest answer.
4. **Agent `command`.** Usually a bare name, sometimes an absolute path
   that does not exist on the other machine. Sync it and fall back to
   the local value when the synced one is not on `PATH`, or keep it
   local?
5. **Pull cadence.** Launch and focus are built. A long-running window
   that never blurs still has no timer. That proposal is in "Phase 2"
   below, and it needs the maintainer's approval because it pushes on
   its own.
6. **Phase 1 as plain export/import.** Should phase 1 be a file export
   and import with no git at all, which helps users who will never set
   up a repo, and make git the transport in phase 2?

## Phase 2

The focus sync is built. A window that regains focus syncs (pulls and
pushes) when the later of `last_pull_at` and `last_sync_at` is at
least five minutes old (`sync_focus_pull`, `focus_pull_due`). Rust
decides under `SYNC_LOCK`. A conflict or a sign-in failure from that
sync, or from the launch sync, toasts once and opens Settings > Sync.
An offline failure does not toast. The rest of this section is not
approved: the timer and the push-on-change. It is not a schedule, and
it is not something a user can wire up from outside the app. Add the
timer only if the maintainer wants users to have that setting. Leave
the file here until then: an idea does not get an issue.

### Why this is not a schedule

Schedules and sync do different jobs.

A schedule run starts an agent. It creates a task, opens an agent
terminal, spends model tokens, and writes a report under
`.termic/schedules/`. A sync is a git operation. When nothing changed
it does not commit and does not push. No agent is involved.

A schedule belongs to a task inside one project. Sync is one clone for
the whole machine, under the data dir, shared by every profile. There
is no project to attach a schedule to.

The clone sits where a caged agent cannot reach it. The Seatbelt
profile denies the data dir, and Docker never mounts `sync/` (see
"Where the clone lives" above). There is no `termic sync` command and
no MCP tool an agent could call.

A schedule fires daily, on weekdays, or weekly, at a clock time. Sync
wants a pull every few minutes, or when something changed.

What is worth copying is the shape of the two minute timers already
started from `src/App.tsx`: the queued-message ticker
(`src/lib/scheduledTicker.ts`) and the schedule runner
(`src/lib/schedules/runner.ts`). Each is one JavaScript check a minute.
Neither is a Rust sleep loop, and neither writes when there is nothing
to do. See [performance.md](../performance.md), bear trap 9.

### Why a user cannot set this up

"Sync now" is the only manual control, and that is the safe one. A cron
job or a launchd agent that runs `git pull` inside the sync clone is
not. It can publish this machine's older settings over another
machine's edits.

`run_core` decides what is new by comparing `origin/<branch>` before
its own fetch with the same ref after (the `old_up` / `base_up` pair).
Apply runs only when that fetch moves the ref. An outside `git pull`
has already moved the ref, HEAD, and the worktree, so the next termic
run:

- exports this machine's settings over the files the pull just wrote
  (`export_all` runs before the fetch)
- commits them when the bytes differ (`commit_if_dirty`)
- fetches, finds the ref where the outside pull left it, and skips
  apply
- on a run that pushes ("Sync now", or any later automatic push),
  pushes that commit

The branch tip is then this machine's older settings. The other
machine's edits remain in the parent commit, and not in the files.
This is a reading of `run_core`. It has not been tested.

### What to build, cheapest first

1. **Sync when a window regains focus and on launch.** Built.
   `sync_focus_pull` and `sync_launch_pull` run with `push: true`.
   `sync_launch_pull` cannot be called again (`LAUNCH_PULLED`), so the focus
   sync is its own command. The due check is the later of `last_pull_at`
   (set at the start of every `run_core`, including a failure) and
   `last_sync_at`. Several open windows share one answer because the
   check and the run hold `SYNC_LOCK`. While `state.conflicts` is
   non-empty the command returns those paths and does not fetch:
   `run_core` itself does not refuse to start while one is waiting.

2. **A "Sync automatically" toggle** that runs the existing "Sync now"
   about every fifteen minutes, and on focus. That is an auto-push
   without a "settings changed" signal, which does not exist yet. When
   nothing changed, `write_if_changed` leaves the clone's files alone,
   `commit_if_dirty` makes no commit, and `after_apply` emits no
   `termic://sync-changed`. The run still fetches, and it still writes
   `last_sync_at`. This option breaks the current sentence, "Nothing
   is pushed until you press Sync now", so it needs the maintainer's
   approval, and the sentence changes in en and zh-CN together.

   The tick should be the minute-check shape above: one JavaScript
   interval, Rust decides whether fifteen minutes have passed, and a
   tick that is not due does not fetch. A per-window timer that calls
   `sync_now` directly would let every open window fetch.

3. **Push about ten seconds after a settings change.** That needs every
   settings write to go through one function that can act as the change
   signal. "Cost" above counts about 20 files that still write
   localStorage directly, and the Rust settings writes are the same
   kind of gap. Leave this until the focus pull is in, and until the
   toggle too if the maintainer wants it.

### A background conflict has to show up

Built for the launch pull and the focus pull. The list still lives in
Settings > Sync (`SyncSection`). `surfaceConflicts` also toasts the set
once, with Review opening that page, and forgets it when a run or a
resolve reports that nothing is waiting. The same files can toast
again if they conflict later. Safety-default changes already
toasted (`surfaceNotices`).

The same runs stay quiet when the machine is offline
(`syncFailureKind`) and toast a sign-in failure once per distinct
error, again after a later run succeeds. Any other failure toasts once
the same way. A failed run still writes `last_error`, which Settings
shows as "Last sync failed". `fail` does not move `last_sync_at`;
`last_pull_at` is what stops an offline laptop retrying on every focus.
A timer, if one is added, must keep this toast policy.
