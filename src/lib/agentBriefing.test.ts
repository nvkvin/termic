import { describe, it, expect } from "vitest";
import { buildAgentBriefing, cliFallbackCommand } from "./agentBriefing";
import type { Task } from "./types";

const task = {
  id: "task-abc123",
  project_id: "proj-1",
  name: "review-auth",
  branch: "sim/review-auth",
  base_branch: "main",
  path: "/Users/x/.termic/worktrees/review-auth",
  cli: "codex",
  port: 4100,
  created: "2026-08-01T00:00:00Z",
  archived: false,
} as Task;

describe("cliFallbackCommand", () => {
  it("uses the bare command name when the link is on PATH", () => {
    expect(cliFallbackCommand({ path: "/Users/x/.local/bin/termic", name: "termic", on_path: true }))
      .toBe("termic");
  });

  it("uses the absolute path when the link is installed but off PATH", () => {
    // A bare name the login shell can't resolve would make the pasted block
    // silently fail for an agent outside Termic.
    expect(cliFallbackCommand({ path: "/usr/local/bin/termic-dev", name: "termic-dev", on_path: false }))
      .toBe("/usr/local/bin/termic-dev");
  });

  it("falls back to the build's command name when nothing is installed", () => {
    expect(cliFallbackCommand({ path: null, name: "termic-dev", on_path: false })).toBe("termic-dev");
  });

  it("survives the status call failing", () => {
    expect(cliFallbackCommand(null)).toBe("termic");
  });
});

describe("buildAgentBriefing", () => {
  const block = buildAgentBriefing({ task, projectName: "termic", cli: "termic" });

  it("is a short fragment, not a document", () => {
    // It gets pasted INSIDE a larger prompt. The protocol lives in the CLI's
    // own help ($TERMIC_CLI_HELP, `send --help`), so re-teaching it here is
    // what made an earlier draft unreadable. Guard the size, not the prose.
    expect(block.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("tells the reader to preserve the quoting and the variable", () => {
    // The reader is an agent that will REWRITE this line to slot its prompt
    // in, and flipping the outer quotes to single (or inventing a value for
    // $TERMIC_TASK_ID) breaks the reply address silently. This sentence is
    // the only thing here that is not already in the CLI's own help.
    expect(block).toContain("Keep the outer double quotes and leave $TERMIC_TASK_ID as written");
  });

  it("frames WHAT this is before naming it", () => {
    // Pasted cold into someone else's prompt, the identity alone never says
    // why a task id is sitting in the middle of their instructions.
    expect(block.startsWith("You can talk to another coding agent working alongside you:")).toBe(true);
  });

  it("names the task, its project and which agent is running it", () => {
    expect(block).toContain(`the Termic task "review-auth" (project termic, codex)`);
  });

  it("says the channel runs both ways", () => {
    expect(block).toContain("Prompt it, and it prompts you back when it is done");
  });

  it("carries the id and the directory, which the reader cannot derive", () => {
    // The name is renameable, so the id is what a command must address.
    expect(block).toContain("id task-abc123");
    expect(block).toContain("working in /Users/x/.termic/worktrees/review-auth");
  });

  it("addresses the task by id in the command, never by name", () => {
    expect(block).toContain("termic send task-abc123 -p ");
    expect(block).not.toContain("send review-auth");
  });

  it("threads the resolved command through both legs of the exchange", () => {
    // Outbound and the nested reply must both use a command that resolves;
    // an off-PATH install is an absolute path (see cliFallbackCommand).
    const b = buildAgentBriefing({ task, projectName: "termic", cli: "/usr/local/bin/termic-dev" });
    expect(b.match(/\/usr\/local\/bin\/termic-dev/g)).toHaveLength(2);
  });

  it("names what goes in the prompt slot instead of an abstract placeholder", () => {
    expect(block).toContain("<your prompt here: what you want it to do>");
    expect(block).toContain("done: <what you did> -- ");
  });

  it("puts the reply address in DOUBLE quotes so the sender's shell expands it", () => {
    // The whole point: `-p "... $TERMIC_TASK_ID ..."` is substituted by the
    // SENDING agent's shell, handing the receiver a literal id. Single quotes
    // there would block expansion and force a paragraph of instructions.
    const cmd = block.split("\n")[2];
    const arg = cmd.slice(cmd.indexOf(' -p "') + 4);
    expect(arg.startsWith('"')).toBe(true);
    expect(arg.endsWith('"')).toBe(true);
    expect(arg).toContain("$TERMIC_TASK_ID");
    // ...and the inner -p is single-quoted, so it nests without escaping.
    expect(arg).toContain("-p '[Agent message from");
  });

  it("signs both directions so neither agent mistakes a peer for the user", () => {
    // Outbound: the sender's header and signature, its id filled by its shell.
    const cmd = block.split("\n")[2];
    expect(cmd).toContain('-p "[Agent message from <you>, task $TERMIC_TASK_ID]');
    expect(cmd).toMatch(/-- <you>, task \$TERMIC_TASK_ID"$/);
    // The reply: the receiving task signs as itself, with its real id.
    expect(cmd).toContain("-p '[Agent message from codex, task task-abc123] done: <what you did> -- codex'");
  });

  it("never suggests --wait", () => {
    // Discouraging it is the CLI help's job now; the fragment just omits it.
    expect(block).not.toContain("--wait");
  });

  it("degrades to a readable line when the project name is unknown", () => {
    expect(buildAgentBriefing({ task, projectName: null, cli: "termic" }))
      .toContain(`"review-auth" (project unknown project, codex)`);
  });

  it("makes no claim about a worktree, which a main-checkout task has none of", () => {
    // The long draft asserted "working in its own git worktree" for every
    // task, which is simply false for a repo-root one.
    // (Checked as a phrase: the fixture's own dir legitimately contains the
    // word, since worktrees live under .termic/worktrees/.)
    expect(block).not.toMatch(/its own git worktree|working in its/);
  });
});

describe("buildAgentBriefing sandbox caveat", () => {
  const build = (t: Partial<Task>) =>
    buildAgentBriefing({ task: { ...task, ...t } as Task, projectName: "termic", cli: "termic" });

  it("warns that an enforcing task cannot reply at all", () => {
    // An enforcing cage denies the control-plane socket, so the report-back
    // half is unavailable to that agent; without this the reader wires up a
    // reply that never arrives.
    expect(build({ sandbox_mode: "enforce" })).toContain("sandboxed (enforcing)");
    expect(build({ sandbox_mode: "enforce-fs" })).toContain("sandboxed (enforcing)");
  });

  it("stays quiet for off and monitor, which do reach the CLI", () => {
    expect(build({ sandbox_mode: "off" })).not.toContain("sandboxed");
    expect(build({ sandbox_mode: "monitor" })).not.toContain("sandboxed");
    expect(build({})).not.toContain("sandboxed");
  });

  it("reads the legacy sandbox_enabled flag the same way", () => {
    expect(build({ sandbox_mode: undefined, sandbox_enabled: true })).toContain("sandboxed (enforcing)");
  });

  it("costs nothing on a task it does not apply to", () => {
    expect(build({ sandbox_mode: "off" }).split("\n").length).toBe(5);
  });
});
