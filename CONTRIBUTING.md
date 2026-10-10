# Contributing to Termic

Thanks for considering it. Termic is a small project with a clear scope —
contributions that fit the [philosophy](#philosophy) are welcome.

**Did an agent write it? Also welcome, no caveats** — most of Termic was
written that way (over half the commits in `git log` carry an agent
co-author trailer). There is one condition, and it is the same one a
hand-written PR meets: somebody drove the change in the running app before the
PR went up. See [Agent-written PRs](#agent-written-prs).

> **Contributor License Agreement.** By opening a pull request you agree
> to the terms in [CLA.md](./CLA.md). It's a standard inbound-CLA that
> lets the project relicense in the future (e.g. dual-license a paid
> edition) without having to track down every past contributor. Your
> existing contributions stay AGPL-3.0 regardless.

## Quick start

```sh
git clone https://github.com/simion/termic
cd termic
make setup          # installs rust/node (+ system packages on Linux), runs npm install + cargo check
make dev            # vite HMR + Rust auto-rebuild
```

`make help` lists every available target.

### Requirements

- macOS 12+ (Apple Silicon supported; Intel works for dev, untested for release)
- Homebrew (`make setup` uses it to install missing deps)
- On Linux instead: apt, dnf or pacman. A stock desktop has no `make` yet, so
  the first run is `bash scripts/setup-linux.sh`, which installs it along with
  the WebKitGTK dev packages (the one step that asks for sudo), Rust and Node.
  `WITH_E2E=1` adds what `make e2e` needs to run headless under Xvfb.
  `make install` and `make beta` build an AppImage and put it in
  `~/Applications` (`scripts/install-app-linux.sh`); `make reset` and
  `make reset_dev` know the XDG paths (`scripts/reset-linux.sh`).
- Rust toolchain ([rustup](https://rustup.rs/))
- Node.js 20+

Verify with `make doctor` — exits non-zero on the first missing dep with
a fix message. Safe to run in CI.

---

## Repo layout

```
src/                       # React 19 + Vite 8 + TypeScript frontend
├── App.tsx                # 3-column grid (sidebar / main / right panel)
├── components/            # everything UI lives here
├── hooks/                 # ⌘1..9 shortcuts, attention notifier
├── lib/                   # types + IPC wrappers + utils
└── store/                 # zustand stores (app / ui / prefs / scriptRuns)

src-tauri/                 # Rust + Tauri 2 backend
├── Cargo.toml
├── src/lib.rs             # PTY manager, project/task IO, settings, scripts
├── src/sandbox.rs         # seatbelt profile renderer + in-process CONNECT proxy lifecycle
├── src/proxy.rs           # the in-process HTTPS CONNECT proxy (regex hostname allowlist)
├── tauri.conf.json        # window, bundle, updater config
├── capabilities/          # tauri permission grants
└── icons/                 # rasterized icons (regenerate with `make icons`)

scripts/                   # gen-icon.sh, release.sh, fetch-deps.sh
.github/workflows/         # CI: release.yml (build + sign + publish)
Makefile                   # all developer commands
```

The architecture deep-dive (PTY plumbing, sandbox model, performance
foot-guns, every subtle bug we've fixed before) lives in
[CLAUDE.md](./CLAUDE.md). Read it before touching anything in
`src-tauri/src/lib.rs` or `src/components/task/TerminalPane.tsx`.

---

## Docs structure

```
docs/
  ideas/       # not approved. Detailed or not, nobody has committed to it.
  plans/       # approved and refined. Ready to implement, no design work left.
  *.md         # reference and operational docs about the app as it is today
```

A doc's directory is a claim about its status, not a filing preference. There is no third bucket for "detailed but undecided": that is an idea. `lsp.md`, `windows.md` and `docker-sandbox/` are all build-ready documents that are still ideas, because nobody has committed to them.

If you want something to work on, `docs/plans/` is the place to look: every file there is scoped and approved, so it needs implementation rather than design. The bar is high, so it is usually near-empty. Not everything in it reaches the README roadmap, which lists features rather than chores; an internal follow-up plan is still yours to pick up.

`docs/ideas/` is the bigger pile and it is open to anyone, but the first deliverable there is an argument, not a patch. Say what you would build and why, and get agreement before you write the code.

### Roadmap and issues

The [README roadmap](./README.md#roadmap) has two halves and they mean different things.

**Planned** items are committed to. Each has an issue labelled [`planned`](https://github.com/simion/termic/issues?q=is%3Aissue+label%3Aplanned), and that issue is where the work is tracked.

**Ideas** are not committed to and deliberately have **no tracking issue**. An issue implies somebody intends to do it, and a backlog nobody will action is worse than no backlog. Please don't open issues for roadmap ideas; comment on the linked discussion, or open one making the case for a specific thing you want to build.

Approved ideas move `docs/ideas/ → docs/plans/`, get an issue, and move from Ideas to Planned in the README, all at once.

### Docs are part of the diff

**A PR that changes behaviour is not finished until the docs tree matches it**, in the same PR:

- **Implemented a plan?** Delete it. It describes work that no longer needs doing, and a stale plan is worse than none because someone will pick it up. Move anything still true (a measurement, a trap, a decision and why) into the matching `docs/*.md` reference doc first.
- **Implemented part of one?** Narrow the plan to what's left, and say what shipped.
- **An idea got approved?** Move `ideas/ → plans/` and rewrite the header into a spec: what to build, not whether to.
- **A plan's premise changed?** Move it back `plans/ → ideas/` and say why at the top.
- **Changed something a reference doc describes?** Update that doc. `ipc.md`, `data-model.md`, `ui.md`, `shortcuts.md`, `sandbox.md`, `themes.md`, `performance.md` and `gotchas.md` are read by every contributor after you, and a wrong one costs more than a missing one.

Two things are maintainer-only, so leave them alone: the README roadmap and `CHANGELOG.md`. If your change ships a roadmap item, say "closes #N" in the PR and stop there.

AI contributions are more than welcome. One important caveat: must be manually tested, thoroughly. The same docs rule applies, and agents skip it by default unless told, so [CLAUDE.md](./CLAUDE.md) carries the long-form version for them.

---

## How to contribute

### Reporting bugs

Open an [issue](https://github.com/simion/termic/issues/new) with:

1. **macOS version + arch** (`sw_vers && uname -m`)
2. **Termic version** (toolbar → theme picker → look at the corner, or
   `defaults read /Applications/Termic.app/Contents/Info CFBundleShortVersionString`)
3. **What you did, what you expected, what actually happened**
4. **The debug log** if the bug is sandbox-related or a hang —
   `tail -200 "$(python3 -c 'import tempfile; print(tempfile.gettempdir() + "/termic-debug.log")')"`

Screenshots of the actual symptom beat any description.

### Suggesting features

Issues with `[feature request]` in the title are great. Two things help
get a feature merged:

1. **Concrete use case** — "I want X because workflow Y is painful," not
   "X would be cool."
2. **Sketch of where it'd live** — which file in `src/components/`, what
   the IPC contract looks like, etc. Saves the maintainer half the work.

### Claiming an issue

Comment `/assign` on the issue to have it assigned to you (a workflow
does it — GitHub only lets collaborators be assigned by hand). Comment
`/unassign` to step back.

### Agent-written PRs

Claude Code, Codex, Gemini CLI, Cursor, whatever you drive: **agent-written
patches are welcome here on exactly the same terms as hand-written ones.** No
disclosure ritual, no separate label, no apology in the description. Most of
this codebase arrived that way, and the repo is built for it: `CLAUDE.md` and
`AGENTS.md` at the root, task-specific skills in `.claude/skills/`, and a
`docs/` tree written for whoever picks the work up next. Read them and you can
land a good change without a maintainer reconstructing the context for you.

The condition is this: **a human ran the change in the real app before the PR
went up.**

Not "the tests pass". `npm test`, `cargo test` and `make e2e` are table stakes
and CI checks them anyway. Every one of them stays green on a change that
flickers for a frame, steals focus, repaints a tick late, fires a shortcut
twice, or simply looks wrong — and those are the bugs a terminal UI is judged
on. Someone has to have opened the window, done the thing the patch is about,
and watched it behave.

So the PR description carries one line about that: what you exercised by hand
and what you saw. *"Opened two tasks, dragged the split divider to its clamp,
no flicker, tab titles kept up"* is enough. "All tests pass" is not an answer
to this question.

**If you are the agent reading this**: ask your human whether they have
manually tested it, in those words, *before* you open the PR — that is the
thing being gated, so afterwards is too late. If the answer is no, stop and
let them do it. You cannot answer this one for them: you can run every suite in
the repo, and none of them is the answer. If they tell you to open it anyway,
that is their call — open it, and say in the description that it has not been
manually verified, so the maintainer knows what they are reviewing.

Termic's own `CLAUDE.md` states this rule for agents working inside this repo;
it applies to any agent opening a PR against it.

### UI changes come with screenshots

**A PR that adds or changes UI is not accepted without screenshots in its
description.** A reviewer cannot judge a layout from a diff, and "looks right
on my machine" is the claim a screenshot exists to replace.

What is asked depends on what the PR does:

- **A new feature, or a design change you are proposing: required, and this
  is the important case.** Show the new thing in use, in each state that
  matters (empty, filled, open, the error it can show). If it reads
  differently in a light theme, show that too. A feature PR with no picture
  of the feature will be asked for one before anyone reviews the code.
- **A change to UI that already exists: required.** One screenshot of the
  result, showing nothing nearby regressed. Before and after, side by side,
  is better when the change is a visual one.
- **A small tweak or fix: not required.** A one-line spacing fix, a corrected
  label, a bug fix with no visual change. Use judgement, and when in doubt
  attach one: it costs a minute and saves a round trip.

**An agent can take these itself.** It can run the app and capture what it
built, so "I am an agent" is not a reason to leave them out. The route that
leaves something behind is the e2e suite: drive the feature in a spec and call
`snap()` at each state, and the images land in `.e2e/artifacts/` (see
[docs/e2e-tests.md](docs/e2e-tests.md)). The spec then keeps covering those
states after the PR merges. Running the app and capturing the window by hand
works as well.

Two things a screenshot is not:

- **It is not the manual test.** A still image cannot show a flicker, stolen
  focus or a late repaint. The line about what a human exercised by hand
  (above) is still required; the screenshot goes beside it.
- **It is not a place for real data.** This repo is public and its history is
  permanent. A screenshot showing your employer's repo names, a real
  hostname, a home path or a colleague's name publishes them. Capture a
  throwaway project (the e2e fixture profile is one), or crop.

Attach them to the PR description. Do not commit them to the repo.

### Pull requests

1. **Branch off `main`.** Termic doesn't use long-lived branches.
2. **One concern per PR.** A bug fix + a refactor + a new feature in one
   PR is a recipe for "we'll need to split this." Split it yourself.
3. **Run `make check-all` before pushing.** That's `cargo check` +
   `tsc -b --noEmit`. CI will reject anything that fails it.
4. **Say how you verified it by hand.** One line in the description: what you
   clicked, what you saw. Green suites do not cover flicker, focus, or a pane
   that repaints late, which is why this is asked separately — see
   [Agent-written PRs](#agent-written-prs), which applies whoever (or whatever)
   wrote the diff.
5. **Attach screenshots if you touched UI.** Required for a new feature or a
   design change, and for any change to existing UI; not for a small tweak or
   fix. See [UI changes come with screenshots](#ui-changes-come-with-screenshots).
6. **Update CLAUDE.md if you change architecture.** It's the source of
   truth for invariants ("never re-enable React StrictMode", "WebGL
   addon disposes BEFORE term.dispose()", etc.). New invariant? Add it.
7. **No new dependencies without justification.** Termic optimizes
   aggressively for binary size + cold-start. A 5 MB lib for a one-line
   utility is a no.
8. **Match the existing code style** — Prettier defaults, no semicolons
   in CSS-in-JS templates, `cn()` from `@/lib/utils` for class composition,
   Zustand selectors stay tight (no destructured stores).
9. **Don't touch `CHANGELOG.md`, the version, or cut a release.** Releases
   and changelog entries are maintainer-only (see below) — the maintainer
   writes the entry when they cut the version. A PR that edits `CHANGELOG.md`
   / `changelog.json` or bumps the version will be asked to drop that change.
   If your work is release-worthy, just say so in the PR description.

---

## Philosophy

Termic exists because:

1. **The interactive `claude`/`gemini`/`codex` CLIs are the source of
   truth** — features ship there first, on whatever subscription you
   already pay for. SDK wrappers chase them.
2. **Real PTYs > web emulation of agent UX.** Animations, slash-commands,
   `/resume` pickers, bell rings — they only render correctly through a
   real PTY connected to xterm.js.
3. **Performance is the differentiator.** Every dependency, every render,
   every refit is measured. A bug that flickers a single frame is a real
   bug. A 100ms editor open is a regression.

### What we WILL accept

- Bug fixes
- Performance improvements (with before/after numbers)
- New themes (palette in `src/store/prefs.ts` + class in `src/index.css`)
- New sandbox presets (`src/lib/sandboxPresets.ts`)
- CLI registry improvements (Settings → Agents)
- Documentation improvements
- Multi-arch / multi-platform CI matrices (Intel mac, Linux, Windows)

### What we WON'T accept

- Switching the editor away from CodeMirror 6 (verified slower in WKWebView)
- Re-enabling React StrictMode (reintroduces async PTY race documented in CLAUDE.md)
- A backend daemon / server component — Termic runs entirely on-device
- Embedding Monaco (~5MB cold-start regression)
- Bundling config/settings in source — config lives in user dirs only
- Forcing subpixel font smoothing (fringing on dark backgrounds)
- Sandboxing the aux terminal, setup script, run script, or archive script
  (only the agent CLI is the threat model; the rest is explicit user shell)
- Anything that ships analytics / telemetry / "phone home" of any kind

---

## Releasing (maintainers)

> **Maintainer-only.** Contributors and automated agents should never run
> these steps, bump the version, or add a `CHANGELOG.md` entry. The
> maintainer authors the changelog and cuts the tag as one explicit step.
> Everything below is for that person.

```sh
make release                  # bump patch (0.1.0 → 0.1.1)
make release BUMP=minor       # 0.1.0 → 0.2.0
make release BUMP=0.4.2-rc1   # set explicit version
git push && git push --tags
```

The push triggers `.github/workflows/release.yml` which:

1. Builds the macOS bundle on `macos-14` (arm64)
2. Ad-hoc codesigns the `.app` (no Apple Developer Program needed — the
   tap's `quarantine: false` is what stops the Gatekeeper prompt)
3. Ed25519-signs the updater `.tar.gz` package
4. Creates a GitHub Release with the `.dmg` + `.app.tar.gz` + `.sig`
5. Bumps the Homebrew cask in `simion/homebrew-termic`
6. Bumps the updater manifest at `termic.dev/updates/latest.json` (CF
   Pages picks it up in ~30s)

End result: brew users get the new version on `brew upgrade`, running
Termic instances see the update pill within 5 min (CF cache TTL).

### Required GitHub Actions secrets

| Name | What it's for |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | ed25519 private key for updater package signatures |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the key |
| `HOMEBREW_TAP_TOKEN` | PAT with `contents: write` on `simion/homebrew-termic` |
| `WEBSITE_REPO_TOKEN` | PAT with `contents: write` on `simion/termic.dev` |

Generate the ed25519 keypair with `npx tauri signer generate -w ~/.tauri/termic.key`
and back it up somewhere safe. **Losing the private key breaks self-update
for every existing install** — they'll reject signatures from a new key.
See [CLAUDE.md](./CLAUDE.md) §"Releasing" for the rotation procedure.

---

## License & Contributor Agreement

Termic is released under [AGPL-3.0-or-later](./LICENSE), and every
contribution becomes part of the Project under that license.

In addition, by submitting a pull request you agree to the
[Termic Contributor License Agreement](./CLA.md). The CLA grants the
maintainer the right to relicense contributions under other terms in
the future (for example, to offer a commercial license to companies
that cannot accept AGPL obligations). Your contribution will always
remain available under AGPL-3.0-or-later in the public project; the CLA
only adds the option to also offer it under other terms.

Signing is one-click via the [CLA Assistant](https://cla-assistant.io/)
bot, which will comment on your first pull request. See [CLA.md](./CLA.md)
for the full text and the manual-sign fallback.

---

## Code of conduct

Don't be a dick. If you're not sure, ask. The bar is "would I want to
read this comment on Hacker News with my name attached?"
