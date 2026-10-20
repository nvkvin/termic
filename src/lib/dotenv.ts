import * as ipc from "./ipc";

/** Parse a simple .env file content into key-value environment variables.
 *  Supports unquoted, single-quoted, double-quoted values, inline comments (#), and lines prefixed with "export ". */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const clean = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIdx = clean.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = clean.slice(0, eqIdx).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    let val = clean.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip unquoted inline comments like `val # comment`
      const commentIdx = val.search(/\s+#/);
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      } else if (val.startsWith("#")) {
        val = "";
      }
    }
    out[key] = val;
  }
  return out;
}

/** Prefix a shell command to source .env and .env.local if present in the worktree,
 *  re-applying any explicit CLI environment overrides so settings trumps .env. */
export function wrapWithDotEnv(cmd: string, overrides?: Record<string, string>): string {
  if (cmd.startsWith("[ -f .env ]")) return cmd;
  let prefix = "[ -f .env ] && set -a && . ./.env 2>/dev/null && set +a; [ -f .env.local ] && set -a && . ./.env.local 2>/dev/null && set +a;";
  if (overrides && Object.keys(overrides).length > 0) {
    const exports = Object.entries(overrides)
      .map(([k, v]) => `export ${k}="${String(v).replace(/"/g, '\\"')}";`)
      .join(" ");
    prefix = `${prefix} ${exports};`;
  }
  return `${prefix} ${cmd}`;
}

/** Load .env and .env.local from a task path and return parsed variables. */
export async function loadTaskDotEnv(taskPath?: string): Promise<Record<string, string>> {
  if (!taskPath) return {};
  const env: Record<string, string> = {};
  for (const filename of [".env", ".env.local"]) {
    try {
      const fullPath = `${taskPath}/${filename}`;
      const text = await ipc.fileReadExternal(fullPath);
      Object.assign(env, parseDotEnv(text));
    } catch {
      // file does not exist or unreadable, ignore
    }
  }
  return env;
}
