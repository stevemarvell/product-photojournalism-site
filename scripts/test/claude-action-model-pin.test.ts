import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An unpinned claude-code-action step runs on whatever the default model is,
// which can drift. Every step must pass --model in its claude_args.
const DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  ".github/workflows",
);

const actionSteps = (text: string) =>
  // Steps start at "- " lines; split on them and keep those using the action.
  text
    .split(/\n\s+- (?=\w+:)/)
    .filter((s) => /uses:\s*anthropics\/claude-code-action@/.test(s));

const workflows = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

describe("every claude-code-action step pins its model", () => {
  for (const file of workflows) {
    const steps = actionSteps(readFileSync(join(DIR, file), "utf8"));
    for (const [i, step] of steps.entries()) {
      it(`${file} step ${i + 1} passes --model in claude_args`, () => {
        const args = step.match(/claude_args:\s*\|\n((?:[ \t]+.*\n?)+)/);
        expect(args, "claude_args block").not.toBeNull();
        const lines = (args?.[1] ?? "")
          .split("\n")
          .filter((l) => !l.trim().startsWith("#"));
        expect(lines.some((l) => /^\s*--model\s+\S+/.test(l))).toBe(true);
      });
    }
  }

  it("finds the steps it is meant to check", () => {
    // 2 in claude-code-review.yml + 1 in claude.yml.
    const all = workflows.flatMap((f) =>
      actionSteps(readFileSync(join(DIR, f), "utf8")),
    );
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});
