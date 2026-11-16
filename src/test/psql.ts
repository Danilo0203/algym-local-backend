import { execFileSync } from "node:child_process";

export interface RunPsqlSqlOptions {
  cwd?: string;
  /**
   * "capture" returns stdout with LF line endings (stderr goes into the thrown
   * error); "ignore" discards both.
   */
  output?: "capture" | "ignore";
}

/**
 * Runs SQL with psql, sending it through stdin as UTF-8.
 *
 * Passing SQL as a `-c` argument breaks non-ASCII text on Windows: arguments
 * reach psql converted to the ANSI code page (e.g. "é" as 0xE9) while the
 * server expects UTF-8. `--single-transaction` keeps the all-or-nothing
 * behaviour that `-c` has for multi-statement strings.
 */
export function runPsqlSql(
  args: readonly string[],
  sql: string,
  options: RunPsqlSqlOptions = {},
): string {
  const capture = options.output === "capture";
  const stdout = execFileSync("psql", [...args, "--single-transaction", "--file=-"], {
    cwd: options.cwd,
    input: Buffer.from(sql, "utf8"),
    stdio: ["pipe", capture ? "pipe" : "ignore", capture ? "pipe" : "ignore"],
    encoding: "utf8",
  });
  // psql on Windows ends lines with CRLF; normalize so callers can split on "\n".
  return capture ? stdout.replace(/\r\n/g, "\n") : "";
}
