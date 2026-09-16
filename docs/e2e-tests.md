# Written end-to-end tests (WebdriverIO)

Automated, repeatable e2e tests that launch the **real** Termic window, click
through real flows, and assert on live state. Purpose: catch regressions when
a feature changes. These are the *written* counterpart to the ad-hoc
[automation bridge](automation.md) / [`e2e` skill](../.claude/skills/e2e/SKILL.md)
(which stays, for agent-driven one-off verification).

## Why WebdriverIO (and not a home-grown harness)

Termic on macOS renders in **WKWebView**, which exposes no Chrome DevTools
Protocol and no native WebDriver, so stock Playwright/Selenium can't attach.
The one established framework with a native macOS path is **WebdriverIO** via
`@wdio/tauri-service`'s *embedded* provider: the Rust crate `tauri-plugin-wdio`
embeds a W3C WebDriver server inside the webview, and WebdriverIO speaks to it.
Real framework, standard API (`$`, `waitUntil`, auto-retrying `expect`), real
window, real screenshots. We did not invent a test framework.

## Zero production footprint

Everything test-only is behind a Cargo feature, `e2e`:

- `src-tauri/Cargo.toml` — `tauri-plugin-wdio-webdriver` is an **optional**
  dep; `[features] e2e = ["dep:tauri-plugin-wdio-webdriver"]`.
- `src-tauri/src/lib.rs` — the plugin registration
  (`tauri_plugin_wdio_webdriver::init()`) is `#[cfg(feature = "e2e")]`. The
  plugin exposes no IPC commands and starts only an HTTP WebDriver server, so
  it needs **no** capability/ACL entry — `capabilities/default.json` is
  untouched.
- All npm packages are `devDependencies`.

A normal `npm run tauri:dev` and every release build contain **none** of it:
no plugin, no WebDriver server. (`cfg(debug_assertions)` can't gate a
dependency — Cargo ignores it with a warning — which is why this is a feature,
not a profile check.)

Note on the npm side: `@wdio/tauri-service@1.2.0` ships a broken pin
(`@wdio/native-utils@2.4.0`) but imports a symbol only present in 2.5.0, so
`package.json` carries an `overrides` bumping `@wdio/native-utils` to `2.5.0`.
Revisit when the tauri-service fixes its pin.

## Run it

```sh
make e2e              # build the --features e2e binary + run the whole suite
# or, à la carte:
npm run e2e:build     # VITE_E2E=1 tauri build --debug --no-bundle --features e2e
npm run test:e2e      # wdio run ./wdio.conf.ts (skip the rebuild while iterating on specs)
```

`e2e:build` produces a self-contained debug binary at
`src-tauri/target/debug/termic` (embedded frontend, so no vite server needed at
test time). Rebuild it after any Rust or frontend change. Screenshots land in
`.e2e/artifacts/` (gitignored). Do NOT build the e2e binary with a bare
`cargo build` — that bakes in the dev-server URL and the window comes up blank
(`about:blank`); always go through `e2e:build` / `make e2e`.

The e2e binary is built with `VITE_E2E=1`, which exposes `window.__termic`
(stores + ipc + invoke) so specs can read real app state and drive real IPC.
That flag is unset in normal `npm run build`, so real release bundles still
tree-shake `__termic` out.

Tests run **on a real Mac only** — they launch a GUI window.

## CI

An `e2e` job in `.github/workflows/test.yml` runs the suite on `macos-14` for
PRs and pushes to `main`. It is **not a required check yet** — it's there to
surface flakiness under CI so we can harden it before gating merges. The
gitignored `.e2e/` fixture profile is recreated by `node scripts/e2e-seed.mjs`
(templates in `scripts/e2e-seed/`); screenshots are skipped when `CI` is set
(the `snap()` helper). Artifacts upload on failure. To promote it to required,
add it to branch protection once it's proven stable over ~20-30 runs.

## Isolation

`wdio.conf.ts` points the launched app at a throwaway `TERMIC_DATA_DIR`
(`.e2e/profile`, the same seeded profile the `e2e` skill uses: `welcomed=true`
+ the `fixture-repo` project + the zero-token `fakeagent`). A run never touches
your real `termic_dev` data. Agent flows use `fakeagent` (`scripts/fake-agent.sh`)
so no real tokens are spent.

Worktree tasks land in `.e2e/tasks/` and **nowhere else**. They used to be
created under `~/termic_dev/tasks/fixture-repo`, mixed in with the developer's
own dev tasks, where nothing could safely clean them up: a run killed mid-spec
left a worktree behind, and every later run then failed on `a worktree already
lives at …` (or, once the directory was gone but the registration was not,
`branch … is already checked out elsewhere`). `seed()` now wipes that directory
and prunes the fixture repo's worktrees on every run.

The task RECORDS are swept separately, by `wdio.conf.ts`'s `onPrepare` — that
runs on every `test:e2e`, including runs that skip the seed script.

The seeded `fixture-repo` carries an `origin` remote (a sibling bare repo,
`.e2e/fixture-repo-origin.git`) so `origin/main` resolves like a real cloned
checkout. This matters because the project default base is `origin/main`: any
worktree spawn that honors it (a plain New Task, and every Agent Race racer)
would otherwise die with `git branch ... origin/main → not a valid object name`.
A spec that repoints origin (e.g. `git.e2e.ts`'s commit-push) MUST restore the
seeded origin in teardown, or the later `agent race` test loses its base.

**A spec that commits must commit something NEW.** `make e2e` reseeds, but
`npm run test:e2e` on its own does not, so the fixture repo carries the last
run's commits. `git.e2e.ts` used to write a fixed `history-probe.txt` with
fixed contents: on the second bare run `git add` staged nothing, `git commit`
exited non-zero, and the `execSync` throw took the whole describe with it (four
failures, none of them about what they claimed to test). Both the file name and
the subject are stamped now. The general rule: anything a spec commits should
be unique per run, and any assertion that a file is an ADD in that commit is
only true while the name is.

## Writing a test for a new feature

The full authoring workflow lives in the **`e2e` skill**
(`.claude/skills/e2e/SKILL.md`) — load it when adding or updating tests. In
short: one spec file per feature area under `e2e/specs/*.e2e.ts`, one `it` per
user-observable outcome, built from the shared helpers in `e2e/helpers.ts`
(`waitForAppShell`, `clickByText`, `waitForText`, …). Read real state via
`window.__termic` rather than scraping the DOM.

The non-negotiable stability rules (this is what keeps the suite from going
fuzzy):

1. **Never sleep.** No `setTimeout`/fixed waits. Use `browser.waitUntil(...)`
   or an auto-retrying `expect(...)`. Every wait is a *condition*, not a
   duration.
2. **Assert on state, not pixels.** Screenshots are for humans to eyeball, not
   for assertions. Assert DOM text/attributes, or app state.
3. **Terminal content is NOT in the DOM.** xterm renders to a WebGL canvas —
   `innerText` never contains PTY output. Assert terminal activity via app
   state (e.g. `lastOutputAt`) read with `browser.execute`, exactly as the
   `e2e` skill does. All other UI (sidebar, tabs, dialogs, Git panel) is normal
   DOM.
4. **Stable selectors.** Prefer role/visible-text; add a `data-testid` only
   where text is ambiguous or localized. Never depend on generated class names.
5. **Deterministic fixtures.** Reset/seed via the isolated profile; don't rely
   on state left by a previous test.
6. **Wait for READY, not for EXISTS.** A resource existing is not the same as
   it being able to do its job, and the gap between the two is where flake
   lives. Before submitting to an agent use `waitForAgentReady()`, not
   `waitForAgentPty()`: the latter resolves the moment Rust reports a `ptyId`,
   which says a process was spawned and nothing more.
7. **Verify the action landed.** An input event that dispatches without
   throwing has not necessarily been handled. `submitToAgent()` now checks
   that `lastInputAt` advanced, so a dropped submit fails at the submit with
   the real reason rather than 15s later at an unrelated assertion.

### The badge flake, and what it taught us

For a while the CI run failed almost every time, on a *different* badge spec
each run, always with `[null, null]`. That pattern reads as randomness and is
why it went unfixed: a real regression fails the same spec every time.

One bug, not many. `waitForAgentPty` returned as soon as the PTY existed, so a
spec could dispatch keystrokes at an xterm that had not yet wired its
`_inputEvent` handler. The events went nowhere, `submitToAgent` still reported
success, the fixture never emitted its OSC, and the badge assertion timed out
15s later blaming the app. On a laptop the window between "PTY exists" and
"xterm accepts input" is invisible. On a loaded 3-core CI runner it is wide
enough to lose regularly, and *which* spec lost was luck.

The fix is rules 6 and 7. `waitForAgentReady` waits for the fixture's OSC title
to reach the store, which proves process spawned + script running + xterm
parsing + store wired in one condition. An xterm parsing OSC will deliver
input.

Generalise it: when a spec fails intermittently and the failure moves around,
suspect a readiness precondition shared by all of them rather than N separate
timing bugs. And prefer a condition that proves the whole chain over one that
proves the first link.

Skeleton:

```ts
describe("my feature", () => {
  it("does the observable thing", async () => {
    await $("button=New task").click();
    await expect($("[data-testid='task-view']")).toBeDisplayed(); // auto-retries
  });
});
```

### The e2e build never takes focus (and must not)

Each spec file launches its own instance, so a run launches seventeen. Under
`--features e2e` the app therefore sets `ActivationPolicy::Accessory` before
showing its window and skips the `set_focus()` a normal launch does
(`lib.rs`). On macOS `set_focus()` activates the app, and activating yanks the
user to whichever Space the window opened on: seventeen Space switches through
a four-minute run, on the machine of whoever is running the suite.

Nothing in the suite needed that focus. Specs drive the webview through
synthetic events, store writes and IPC, none of which care which app is
frontmost, and the window was already occluded anyway (see below). Do not add a
`set_focus()`, a `.show()` that activates, or an Accessory-to-Regular flip on
this path to make a spec pass: the spec is reaching for OS focus it should not
need, and the cost is the user's attention every time the suite runs.

### The window is hidden, so nothing animates

`document.hidden` is `true` for the whole run: the harness never brings the
window to the front. WebKit freezes `requestAnimationFrame` in a window it
believes is occluded, so **no rAF callback ever fires** in a spec. Anything the
app defers to a frame is deferred forever.

CodeMirror schedules its layout measurement that way. Until it runs, CM's
height map holds its unmeasured default of 14px per line while the rendered
lines are really 20, so each gutter number sits 6px above its code and the gap
grows down the file. A gutter-alignment spec then reports exactly the drift it
exists to catch, produced entirely by the harness. Waiting does not help: the
frame is never coming.

`flushEditorMeasure()` in `helpers.ts` runs the pending measure synchronously
(via `coordsAtPos`, whose public read flushes it) and returns how many editors
it touched, so a CodeMirror upgrade that moves the view handle fails loudly
instead of silently going back to measuring nothing. **Call it before reading
any geometry out of a CodeMirror editor.**

The same applies to product code that leans on rAF: it is invisible in a spec.
`cd359ba` moved the command palette's deferred effect from rAF to a macrotask
for the user-facing half of this (a palette command fired minutes late, over
whatever the user was doing by then, once the window came back).

## The driver cannot hold Control

Measured, not assumed, while writing the ⌃⇥ cases in `tabs-layout.e2e.ts`.
`browser.action("key").down(Key.Control)...` delivers a `Control` keydown and
keyup to the page, but every key pressed while it is notionally held still
arrives with **`ctrlKey: false`**. Meta behaves correctly by comparison: the
same sequence with `Key.Ctrl` (which WebdriverIO maps to Cmd on macOS, itself
a trap worth knowing) does set `metaKey: true` on the keys in between.

So a held-Control gesture cannot be driven from the suite at all, and a spec
that tries reports "the key never arrived" whether or not the feature works.
Drive such gestures with synthetic `KeyboardEvent`s instead — dispatched at the
element that would really receive them, never at `window`, or the spec proves
nothing about whether xterm eats the key first.

What that leaves uncovered is narrow but real: whether macOS and WKWebView hand
the chord to the page at all. Nothing in the app intercepts it natively (there
are no Tauri accelerators or `global_shortcut` registrations), but only a human
at the keyboard can confirm it.

## The one maturity caveat

`@wdio/tauri-service` + `tauri-plugin-wdio` are young (1.x, late-2025 / 2026).
They are maintained by the WebdriverIO org, but if a version regresses, pin the
last-known-good `@wdio/*` and `tauri-plugin-wdio` together (they release in
lockstep). The bridge/`e2e` skill remains as a fallback for manual checks.

## Typechecking the specs

`npm run typecheck:e2e` (`tsc -p e2e/tsconfig.json --noEmit`) covers `e2e/`,
`perf/` and both wdio configs. None of it is in the app's `tsc -b` project, so
`npm run build` says nothing about it, and by the time anyone looked there were
71 errors: mostly spec-scope `let taskId: string | undefined` flowing into
`browser.execute`, whose callback param then cannot index the store, plus two
perf report units that were simply not in the union they claimed. It runs in CI
beside the unit tests now.

Two conventions that keep it clean. Spec-scope ids are declared with a definite
assignment (`let taskId!: string`) because a before hook assigns them and the
after hooks still guard at runtime. And anything read out of `window.__termic`
is annotated at the boundary: the store is loosely typed, so an unannotated
value passed into another `execute` arrives as WebdriverIO's `HTMLElement`
union and every use of it is an implicit any.
