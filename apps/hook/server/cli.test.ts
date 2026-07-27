import { describe, expect, test } from "bun:test";
import {
  formatInteractiveNoArgClarification,
  formatIndexSuccess,
  formatSubcommandHelp,
  formatTopLevelHelp,
  formatVersion,
  hasHelpFlag,
  isInteractiveNoArgInvocation,
  isSubcommandHelpInvocation,
  isTopLevelHelpInvocation,
  isVersionInvocation,
  parseAtlasCommandArgs,
} from "./cli";

describe("CLI top-level help", () => {
  test("recognizes top-level --help", () => {
    expect(isTopLevelHelpInvocation(["--help"])).toBe(true);
    expect(isTopLevelHelpInvocation(["-h"])).toBe(true);
    expect(isTopLevelHelpInvocation([])).toBe(false);
    expect(isTopLevelHelpInvocation(["review", "--help"])).toBe(false);
  });

  test("renders concise top-level usage", () => {
    const output = formatTopLevelHelp();

    expect(output).toContain("plannotator --help");
    expect(output).toContain("plannotator --version, -v");
    expect(output).toContain("plannotator [--browser <name>]");
    expect(output).toContain("plannotator review [--atlas] [--git | --gitbutler] [PR_URL]");
    expect(output).toContain("plannotator explore [path]");
    expect(output).toContain("plannotator index [path]");
    expect(output).toContain("plannotator annotate <file.md | file.txt | file.html | https://... | folder/>");
    expect(output).toContain("[--markdown] [--no-jina]");
    expect(output).toContain("plannotator annotate-last [--stdin]");
    expect(output).toContain("plannotator setup-goal <interview|facts>");
    expect(output).toContain("Run 'plannotator <command> --help' for command-specific usage.");
    expect(output).toContain("running 'plannotator' without arguments is for hook integration");
  });
});

describe("CLI subcommand help", () => {
  test("hasHelpFlag detects --help / -h anywhere", () => {
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["-h"])).toBe(true);
    expect(hasHelpFlag(["file.md", "--help"])).toBe(true);
    expect(hasHelpFlag(["--git"])).toBe(false);
    expect(hasHelpFlag([])).toBe(false);
  });

  test("recognizes `review --help` as a subcommand help invocation", () => {
    expect(isSubcommandHelpInvocation(["review", "--help"])).toBe("review");
    expect(isSubcommandHelpInvocation(["review", "-h"])).toBe("review");
    // help flag may appear after other args (agents probe in various ways)
    expect(isSubcommandHelpInvocation(["annotate", "file.md", "--help"])).toBe(
      "annotate",
    );
  });

  test("does not treat a real review invocation as help", () => {
    expect(isSubcommandHelpInvocation(["review"])).toBeNull();
    expect(isSubcommandHelpInvocation(["review", "--git"])).toBeNull();
    expect(isSubcommandHelpInvocation(["review", "--gitbutler"])).toBeNull();
    expect(
      isSubcommandHelpInvocation([
        "review",
        "https://github.com/owner/repo/pull/1",
      ]),
    ).toBeNull();
  });

  test("resolves the `last` alias to annotate-last help", () => {
    expect(isSubcommandHelpInvocation(["last", "--help"])).toBe("annotate-last");
    expect(isSubcommandHelpInvocation(["annotate-last", "--help"])).toBe(
      "annotate-last",
    );
  });

  test("covers every command advertised in top-level help", () => {
    // Each command listed in formatTopLevelHelp() must respond to --help so the
    // advertised "run 'plannotator <command> --help'" contract holds.
    for (const sub of [
      "annotate",
      "setup-goal",
      "archive",
      "explore",
      "index",
      "sessions",
      "improve-context",
    ]) {
      expect(isSubcommandHelpInvocation([sub, "--help"])).toBe(sub);
    }
  });

  test("ignores help flags for unknown / internal subcommands", () => {
    expect(isSubcommandHelpInvocation(["opencode-review", "--help"])).toBeNull();
    expect(isSubcommandHelpInvocation(["install-runtime", "--help"])).toBeNull();
    expect(isSubcommandHelpInvocation(["--help"])).toBeNull();
    expect(isSubcommandHelpInvocation([])).toBeNull();
  });

  test("renders subcommand-specific usage", () => {
    expect(formatSubcommandHelp("review")).toContain(
      "plannotator review [--atlas] [--git | --gitbutler]",
    );
    expect(formatSubcommandHelp("explore")).toContain(
      "plannotator explore [path]",
    );
    expect(formatSubcommandHelp("index")).toContain("plannotator index [path]");
    expect(formatSubcommandHelp("index")).toContain("Build a codebase atlas");
    expect(formatSubcommandHelp("index")).toContain("--semantic");
    expect(formatSubcommandHelp("explore")).toContain("--index-path");
    expect(formatSubcommandHelp("review")).toContain("--gitbutler");
    expect(formatSubcommandHelp("review")).toContain("--atlas");
    expect(formatSubcommandHelp("review")).toContain("PR_URL");
    expect(formatSubcommandHelp("annotate")).toContain("--no-jina");
    expect(formatSubcommandHelp("sessions")).toContain("--open [N]");
    // unknown key falls back to top-level help
    expect(formatSubcommandHelp("nope")).toBe(formatTopLevelHelp());
  });
});

describe("CLI --version", () => {
  test("recognizes --version and -v", () => {
    expect(isVersionInvocation(["--version"])).toBe(true);
    expect(isVersionInvocation(["-v"])).toBe(true);
    expect(isVersionInvocation([])).toBe(false);
    expect(isVersionInvocation(["review"])).toBe(false);
  });

  test("formats version string", () => {
    const output = formatVersion();
    expect(output).toStartWith("plannotator ");
  });
});

describe("CLI index result", () => {
  test("formats one concise result line with counts, source, and index path", () => {
    expect(formatIndexSuccess({
      files: 42,
      symbols: 317,
      source: "fresh",
      indexPath: "/tmp/plannotator/atlas.sqlite",
    })).toBe(
      "Indexed 42 files, 317 symbols (fresh); index: /tmp/plannotator/atlas.sqlite",
    );
  });

  test("formats blocking semantic index results", () => {
    expect(formatIndexSuccess({
      files: 42,
      symbols: 317,
      source: "cache",
      indexPath: "/repo/.plannotator/atlas.sqlite3",
      semantic: {
        completed: 20,
        cached: 8,
        resolved: 10,
        unsupported: 1,
        failed: 1,
      },
    })).toContain(
      "semantic: 20 queries (8 cached, 10 resolved, 1 unsupported, 1 retryable)",
    );
  });

});

describe("Atlas command arguments", () => {
  test("parses a path and portable index override", () => {
    expect(parseAtlasCommandArgs([
      "--semantic",
      "--index-path",
      ".cache/atlas.sqlite3",
      "./repo",
    ], { allowSemantic: true })).toEqual({
      rootPath: "./repo",
      indexPath: ".cache/atlas.sqlite3",
      semantic: true,
    });
  });

  test("allows an index path override for explore", () => {
    expect(parseAtlasCommandArgs([
      "/repo",
      "--index-path",
      "/indexes/repo.sqlite3",
    ])).toEqual({
      rootPath: "/repo",
      indexPath: "/indexes/repo.sqlite3",
      semantic: false,
    });
  });

  test("rejects incomplete, duplicate, and unsupported options", () => {
    expect(() => parseAtlasCommandArgs(["--index-path"]))
      .toThrow("--index-path requires");
    expect(() => parseAtlasCommandArgs(["one", "two"]))
      .toThrow("Only one repository");
    expect(() => parseAtlasCommandArgs(["--wat"]))
      .toThrow("Unknown option");
    expect(() => parseAtlasCommandArgs(["--semantic"]))
      .toThrow("only supported");
  });
});

describe("interactive no-arg invocation", () => {
  test("detects bare interactive invocation only when stdin is a TTY", () => {
    expect(isInteractiveNoArgInvocation([], true)).toBe(true);
    expect(isInteractiveNoArgInvocation([], false)).toBe(false);
    expect(isInteractiveNoArgInvocation([], undefined)).toBe(false);
    expect(isInteractiveNoArgInvocation(["review"], true)).toBe(false);
  });

  test("renders clarification for interactive users", () => {
    const output = formatInteractiveNoArgClarification();

    expect(output).toContain("usually launched automatically by Claude Code hooks");
    expect(output).toContain("It expects hook JSON on stdin.");
    expect(output).toContain("plannotator review");
    expect(output).toContain("plannotator explore [path]");
    expect(output).toContain("plannotator index [path]");
    expect(output).toContain("plannotator setup-goal interview bundle.json --json");
    expect(output).toContain("plannotator sessions");
    expect(output).toContain("Run 'plannotator --help' for top-level usage.");
  });
});
