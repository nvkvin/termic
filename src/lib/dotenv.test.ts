import { describe, it, expect, vi } from "vitest";
import { parseDotEnv, wrapWithDotEnv, loadTaskDotEnv } from "./dotenv";

vi.mock("./ipc", () => ({
  fileReadExternal: vi.fn(async (path: string) => {
    if (path.endsWith(".env.local")) {
      return "STARROCKS_USER=override_user\nLOCAL_ONLY=true\n";
    }
    if (path.endsWith(".env")) {
      return `
# Database Configuration
STARROCKS_USER=default_user
STARROCKS_PASSWORD="secret_pass_123"
export DB_PORT=9030
# Empty and single-quoted
FOO='bar baz'
EMPTY=
      `;
    }
    throw new Error("File not found");
  }),
}));

describe("dotenv support", () => {
  it("parses .env key-value pairs including quotes, inline comments, and export prefix", () => {
    const raw = `
# Comment
STARROCKS_USER=my_user # username for connection
STARROCKS_PASSWORD="super secret # password"
export HOST=localhost
SINGLE='quoted # value'
EMPTY=
COMMENT_ONLY=#only comment
INVALID LINE WITHOUT EQUALS
# Another comment
    `;
    const res = parseDotEnv(raw);
    expect(res).toEqual({
      STARROCKS_USER: "my_user",
      STARROCKS_PASSWORD: "super secret # password",
      HOST: "localhost",
      SINGLE: "quoted # value",
      EMPTY: "",
      COMMENT_ONLY: "",
    });
  });

  it("wraps a command to source .env and .env.local before running", () => {
    const wrapped = wrapWithDotEnv("harlequin");
    expect(wrapped).toContain("[ -f .env ] && set -a && . ./.env 2>/dev/null && set +a;");
    expect(wrapped).toContain("[ -f .env.local ] && set -a && . ./.env.local 2>/dev/null && set +a;");
    expect(wrapped.endsWith(" harlequin")).toBe(true);
  });

  it("applies explicit environment overrides after sourcing", () => {
    const wrapped = wrapWithDotEnv("harlequin", { STARROCKS_USER: "custom_user" });
    expect(wrapped).toContain('export STARROCKS_USER="custom_user";');
    expect(wrapped.endsWith(" harlequin")).toBe(true);
  });

  it("does not double-wrap an already wrapped command", () => {
    const first = wrapWithDotEnv("harlequin");
    const second = wrapWithDotEnv(first);
    expect(second).toBe(first);
  });

  it("loads and merges .env and .env.local for a task path", async () => {
    const env = await loadTaskDotEnv("/path/to/task");
    expect(env.STARROCKS_USER).toBe("override_user");
    expect(env.STARROCKS_PASSWORD).toBe("secret_pass_123");
    expect(env.DB_PORT).toBe("9030");
    expect(env.LOCAL_ONLY).toBe("true");
    expect(env.FOO).toBe("bar baz");
  });
});
