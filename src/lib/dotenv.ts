import * as ipc from "./ipc";

/** Parse a simple .env file content into key-value environment variables.
 *  Supports unquoted, single-quoted, double-quoted values, and lines prefixed with "export ". */
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
    }
    out[key] = val;
  }
  return out;
}

/** Prefix a shell command to source .env and .env.local if present in the worktree. */
export function wrapWithDotEnv(cmd: string): string {
  if (cmd.startsWith("[ -f .env ]")) return cmd;
  const envPrefix = "[ -f .env ] && set -a && . ./.env 2>/dev/null && set +a; [ -f .env.local ] && set -a && . ./.env.local 2>/dev/null && set +a;";
  return `${envPrefix} ${cmd}`;
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
