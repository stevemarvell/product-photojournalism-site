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

const EXPECTED_STEPS = 3;

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

  // The action's default permission mode became `auto` in v1.0.275: a
  // classifier decision rather than "a tool not in --allowedTools is denied".
  // Each step names its mode so an upgrade cannot change it silently.
  for (const file of workflows) {
    const steps = actionSteps(readFileSync(join(DIR, file), "utf8"));
    for (const [i, step] of steps.entries()) {
      it(`${file} step ${i + 1} passes an explicit --permission-mode`, () => {
        const args = step.match(/claude_args:\s*\|\n((?:[ \t]+.*\n?)+)/);
        const lines = (args?.[1] ?? "")
          .split("\n")
          .filter((l) => !l.trim().startsWith("#"));
        const mode = lines
          .map((l) => l.match(/^\s*--permission-mode\s+(\S+)/)?.[1])
          .find(Boolean);
        expect(mode, "--permission-mode value").toBeDefined();
        expect(mode).not.toBe("auto");
        if (file === "claude-code-review.yml") expect(mode).toBe("default");
        if (file === "claude.yml") expect(mode).toBe("acceptEdits");
      });
    }
  }

  it("finds the steps it is meant to check", () => {
    // Counted with a plain regex, not the splitter under test, so a step
    // actionSteps fails to split out is noticed. 2 in claude-code-review.yml
    // + 1 in claude.yml: adding a step means updating EXPECTED_STEPS on purpose.
    let total = 0;
    for (const f of workflows) {
      const text = readFileSync(join(DIR, f), "utf8");
      const uses = text.match(/uses:\s*anthropics\/claude-code-action@/g) ?? [];
      expect(actionSteps(text).length, f).toBe(uses.length);
      total += uses.length;
    }
    expect(total).toBe(EXPECTED_STEPS);
  });
});
