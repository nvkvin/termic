# A status section in the sidebar

**Status: idea, not approved.** Nothing here is built. It proposes a
second collapsible section in the sidebar, above PROJECTS, that lists the
tasks needing attention or in flight, grouped the way the Kanban board
groups them. It replaces the direction of PR #310, a derived phase on the
dashboard. That PR stored a "has worked" flag, which the board has since
ruled out.

## The short version

- The sidebar gets a STATUS section above PROJECTS. It is one sidebar with
  one scroller, and the status section collapses to its header.
- Tasks are grouped by the board's own columns, computed by the board's own
  `taskBoardColumn`. Nothing new is stored, so the sidebar and the board
  cannot disagree.
- Needs attention, Working and In review list their tasks. Settled and Not
  started show only a count, and expand on demand. Empty buckets are
  hidden.
- When a task spawns tasks, the batch stays together, across projects, in
  the bucket of its most urgent member.
- The project tree does not change. Every task keeps one home there, and
  the status section is a copy.

## The problem

With a dozen tasks across several projects, three questions come up all
day: which of these need me, which am I still on, and which are finished
and can go.

Main answers them in several places, and none of those places works while
you are working:

- **The Kanban board** answers all three at once, but it is an overlay in
  the main area. Opening it deselects the open task: `setView` sets
  `activeTaskId: null`. Clicking a card takes you back to the task and out
  of the board. It answers the question when you stop working, not while
  you work.
- **The sidebar** has a work badge on each collapsed row, the PR chip, the
  per-project filter (text or notifications), task groups within a project,
  and a mark on tasks another task started. You find out by scanning rows,
  one project at a time.
- **The "N agents waiting" pill** in the title bar, and ⇧⌘A, step to the
  next waiting agent, one at a time.

The board's own idea doc named the gap (`docs/ideas/kanban-board.md` as
added in e33828d1, since folded into `docs/ui.md`): past a handful of
parallel tasks, the sidebar "answers 'where is task X' but not 'what stage
is everything at'". The board closed the second half on a surface you have
to leave your work to see.

One related question has no answer anywhere yet: how the tasks one agent
spawned across projects relate.

- Task groups cannot span projects. `apply_group_join` refuses with "tasks
  in different projects cannot share a group".
- Spawn links show as hover lines, one level each way.
- The board draws neither.

#298 lists this as one of its "what ifs", and question 6 in
[agent-orchestration.md](agent-orchestration.md) asks how to make the
shape of spawned work visible without drawing a graph.

## The idea

IDE sidebars already solve "the same things, organised two ways". VS
Code's Explorer stacks Open Editors above Folders: the same files, two
arrangements, one sidebar, each part collapsible. Termic's version puts
STATUS above PROJECTS:

```
Dashboard / History / Kanban

v STATUS
  v Needs attention  2
      fix-login           web   (bell)
      api-refresh         api   (bell)
  v Working  1 batch
      auth-plan           api
        -> token-store    api   (spinner)
        -> login-flow     web   (done)
  v In review  1
      docs-pass           web   (PR open)
  > Settled  11
  > Not started  4

v PROJECTS
  v web
      fix-login ...
  v api
      ...
```

## What the research says

The evidence splits cleanly, and the split decides the shape.

**For a short section that copies a subset to the top:**

- **Copying beats moving.** Gajos et al. compared adaptive layouts, and
  found that "Split Interfaces, which duplicate (rather than move)
  frequently used (but hard to access) functionality to a convenient place
  tend to improve users' performance and satisfaction [...] while causing
  minimal confusion" ([AVI 2006][gajos]). What made it work was that the
  familiar part of the interface did not change.
- **Duplicates preserve spatial memory.** Nielsen Norman Group says
  adaptive interfaces break spatial memory. The exception is to "duplicate
  the items both in their normal place and in the Frequently Used area"
  ([NN/g][nng-spatial]).
- **Mainstream apps put the copy above the tree.** Linear's Favorites
  "appears in your sidebar above Your Teams" ([Linear][linear-fav]). Mail's
  Smart Mailboxes and Things' Today list follow the same model: a live
  list of items whose real home is somewhere else.

**Against a full second tree of every task:**

- **VS Code retreated from exactly that.** It hid Open Editors by default in
  1.53 because "the functionality provided in the Open Editors view is
  covered in other areas of the workbench, like tabs" ([VS Code][vsc-153]).
  Here the Kanban board plays the role of tabs: it already owns the full
  grouping.
- **VS Code tells extension authors the same.** Its guidance is to "Keep the
  number of Views to a minimum" ([VS Code][vsc-views]).
- **The copy has to earn its place.** In the second experiment of the same
  paper, where the copied area added nothing, "Many found the Split
  Interface not very useful because it required them to look in two
  distinct places" ([AVI 2006][gajos]). A second full tree is that case.
- **Agent tools use a toggle, not two stacked groupings.** Tools that run
  parallel agents let you group by status or by directory, one at a time.
  None of the ones surveyed shows both at once.

So the section copies the actionable subset, not everything, and the full
grouping stays on the board.

Rejected: a Projects | Status switcher, which is how JetBrains handles its
project views. You need both at once here: the tree says where things live,
and the section says what to do next. Nielsen Norman Group limits tabs to
cases where users "don't need to simultaneously see information presented
under different tabs" ([NN/g][nng-tabs]).

## Design

### The constraint: one derivation, nothing stored

The board's rule on main is: "There is no `status` field on Task and there
must not be one" (`docs/ui.md`, Kanban view). Persisting a "has worked"
flag "would be a stored status".

The section follows the same rule. Its buckets come from `taskBoardColumn`
in `src/lib/taskBoardState.ts`, the function the board uses. If a bucket
turns out wrong for the sidebar, the fix is to change `taskBoardColumn`,
so the board moves with it. A rule that exists only in the sidebar is how
two surfaces start to disagree.

### Buckets

The buckets follow the board's column order, without Archived:

| Bucket | Default | Why |
| --- | --- | --- |
| Needs attention | listed | the reason the section exists |
| Working | listed | what is in flight |
| In review | listed | a PR is waiting on someone |
| Settled | count only | the largest bucket, and the least urgent |
| Not started | count only | session-scoped (see below) |

Not started is session-scoped by design. `taskUntouched` reads in-memory
tab state, so after a relaunch every task that has not been opened lands
there, or in In review if it has a PR. That bucket is mostly noise on a
cold start, which is why it is count-only.

The rules around the buckets:

- An empty bucket is hidden.
- The section header stays even when every bucket is empty, so the section
  cannot silently vanish.
- The collapse state of each bucket, and of the section, persists in scoped
  localStorage keys, like `collapsedGroups`, with setters that bail on an
  unchanged value.
- Archived stays in History and on the board.

### Rows

A status row is a lighter row, modelled on `DashboardTaskRow`: the agent
glyph, the label, the project name in the faint colour, the work badge and
the PR chip. It has no terminal children, no drag, no rename and no run
controls.

- **Clicking** a status row opens the task. `setActiveTask` already reveals
  the task in the tree, expanding its project, folder and group.
- **The active task** is highlighted in both sections, because both rows
  are the same task.
- **Within a bucket,** rows keep the tree's order (project order, then the
  project's own task order). A row never shuffles inside its bucket. It
  moves only when its bucket changes.

### Batches across projects

`spawned_by` is stored on the child's record, and it is the only link a
child in another project has to its parent.

A batch is a root task, meaning one with no live parent, together with all
of its live descendants. The section draws a batch as one unit:

- the root row first
- each descendant indented beneath it, with a `->` mark and its own project
  name
- the batch placed in the bucket of its most urgent member, in this order:
  Needs attention, Working, In review, Settled, Not started

So a settled root sits under Working while one of its children works. Each
row keeps its own badge, so the reason for the placement is visible on the
row that caused it.

This does not break the one-derivation constraint. Every task's own bucket
is still the board's, from `taskBoardColumn`, unchanged. Batching is a
layout rule on top of those buckets: it decides where a group of rows is
drawn, not what any task's state is. The board could adopt the same rule
later (see open questions).

Some cases fall out of that rule:

- A task with no links is a batch of one.
- If a child's parent is archived, the child becomes a root. The spawn
  marks already treat links to archived tasks this way.
- Task groups made by hand from the task menu carry no `spawned_by`, so
  they are not batched in the first slice (see open questions).

This gives what task groups cannot. The tree keeps each child under its
own project, where its worktree lives, and the section shows the batch
together.

### Where it lives, and turning it off

- The section shares the tree's scroller and sits above the PROJECTS
  header.
- A "Show status section" check row goes in the Project list options menu,
  next to "Collapse inactive projects". The same toggle goes in Settings ->
  Appearance -> Sidebar.
- The compact rail hides the section in the first slice. The hover overlay
  shows the full sidebar anyway.

### Does it solve the problem?

- **Which need me?** Yes. They are listed at the top, and visible while you
  work. One gap: the board files a finished turn you have not looked at
  (the blue done dot) under Settled, while the title bar pill counts it as
  waiting (see open questions).
- **Which am I still on?** Mostly. Working and In review cover it, but a
  task you are iterating on between turns sits in Settled with everything
  else that is idle.
- **Which are finished and can go?** Partly. The board has no Done column,
  and a merged PR falls through to Settled. The `on_pr_merge` setting
  already offers to archive a task when its PR merges. A derived Merged
  column in `taskBoardColumn`, read from the PR state the app already polls,
  would fix this on both surfaces (see open questions).
- **Clutter.** The section does not shorten the tree. What it does is make a
  collapsed tree workable: collapse the projects and work from the section.

## Implementation notes

All of this is from reading main.

**The scaffold.** The section is a sibling of the project list inside the
one scroller (`projectsScrollRef` in `Sidebar.tsx`), with a header modelled
on the inactive-projects fold header. Small.

**Identity is the risky part.** Status rows carry an attribute of their
own, such as `data-status-task-id`. They carry none of
`data-sidebar-task-id`, `data-sidebar-task-project-id` or
`data-sidebar-task-row`, and none of the inner testids either (run
controls, badges, menu items).

Several things assume one row per task: the drag hit tests,
`SpawnLinksOverlay`, and two e2e specs that query `[data-sidebar-task-id]`.
The dashboard already solved the same problem with
`data-dashboard-task-id`, and `docs/ui.md` records that `work-badge` is no
longer unique. With distinct attributes, placing the section above the
tree is safe.

**Why not reuse `TaskRow`.** Its rename and auto-expand effects would run
twice. `setTaskCollapsed` has no equality bail, so every expand would
become two whole-state writes (bear trap 8).

**Derive at the body level, not per row.** `taskUntouched` reads
`lastInputAt`, which `useRowTabs` deliberately ignores
(`ROW_HIDDEN_TAB_FIELDS`), so a per-row derivation would miss a task's
first input. Two ways to do it:

- Add the facts the buckets need to `SidebarTaskFacts`.
- Use a string key like `selectBoardColumnKey`, with the short-circuit that
  `createSidebarFactsSelector` has for an unchanged `tabs`.

`selectBoardColumnKey` as it stands walks every task's tabs on every store
write, which the board survives only because it unmounts. The section also
needs a PR re-render trigger, as `BoardView` has, and new pins in
`selectorFanout.test.ts`.

**The rest of the notes:**

- **Pref gating** matches the board: `attentionIndicator` and
  `workingIndicator` decide whether those buckets fill.
- **Keyboard:** ⌥↑/↓ and ⌘[ / ⌘] keep walking project order, and the
  section is mouse-only in the first slice. That needs writing down,
  because keyboard order already drifts from the drawn tree.
- **Drag:** none in the first slice. `boardDropCommand` is pure and could
  be reused later (settle, create a PR, archive) once there is a vertical
  hit test.
- **i18n:** the bucket labels reuse `chrome:board.col*`. The header, the
  counts (as plural pairs) and the toggle need new keys in both `en` and
  `zh-CN`.
- **e2e:** one new spec covering bucket membership, batch placement,
  collapse persistence, the toggle and the active highlight. The helpers
  that assume one row per task need scoping.

**Size:** medium to large, and identity is most of it.

## Slices

1. The section, its buckets, rows, toggle and collapse persistence. No
   batches.
2. Batches across projects.
3. A count on the compact rail, and drops as commands.

## Relation to other work

- **The Kanban board** does not change. The section is its attention half,
  compressed and always on screen.
- **PR #310** (a derived phase on the dashboard, now a draft) is superseded.
  Its persisted `started_at` is the "has worked" flag the board rules out.
- **#298** is the board and properties thread. Gabriel's point there, that
  "the sidebar is where you already look to see what is in flight", is the
  premise of this doc. Free-form properties could later show as text on
  status rows. That is not in scope here.
- **`agent-orchestration.md`, question 6.** Batches are one answer to
  making the shape of spawned work visible without drawing a graph, though
  only once the work exists, not before it starts.

## Open questions

1. **Should a finished turn you have not seen count as Needs attention?**
   The pill and ⇧⌘A say yes, and the board says Settled. If yes, that is a
   change to `taskBoardColumn`, and the board changes with it.
2. **Should `taskBoardColumn` gain a Merged column,** derived from the PR
   state already polled, so that "finished and can go" has an answer on
   both surfaces?
3. **Should the section be on by default?** Someone with two tasks gains
   little from it. Someone with twenty gains the most.
4. **Should task groups made by hand be batched too,** alongside spawn
   trees?
5. **Should Settled and Not started appear at all,** or only as a link to
   the board?
6. **Should a bucket's count show tasks or batches?**
7. **Should the board batch spawned work the same way,** so that a card
   and the cards it spawned sit together there too?

## Not in scope

- Any stored status, goal or parked flag.
- Changes to the project tree.
- A full second tree of every task.
- Reordering inside the section.

[gajos]: https://kgajos.seas.harvard.edu/papers/kgajos-avi06.pdf
[nng-spatial]: https://www.nngroup.com/articles/spatial-memory/
[nng-tabs]: https://www.nngroup.com/articles/tabs-used-right/
[linear-fav]: https://linear.app/docs/favorites
[vsc-153]: https://code.visualstudio.com/updates/v1_53
[vsc-views]: https://code.visualstudio.com/api/ux-guidelines/views
