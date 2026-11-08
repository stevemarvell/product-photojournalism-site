import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Dependabot runs get Dependabot's secrets, so CLAUDE_CODE_OAUTH_TOKEN is empty
// there and no review can start (#244). Each review job must ask first and skip
// the rest, green, when the token is absent. This reads the workflow CI runs
// and executes its token step's own shell, so what is checked is the file, not
// a copy of its logic.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = readFileSync(
  join(REPO_ROOT, ".github/workflows/claude-code-review.yml"),
  "utf8",
);

interface Step {
  text: string;
  name: string;
  id?: string;
  condition?: string;
}

/** A job's steps, each as raw text with its name, id and `if:` pulled out. */
function steps(job: string): Step[] {
  const header = `\n  ${job}:\n`;
  const start = WORKFLOW.indexOf(header) + header.length;
  const next = WORKFLOW.slice(start).search(/^ {2}[a-z-]+:\n/m);
  const section = WORKFLOW.slice(start, next === -1 ? undefined : start + next);
  const body = section.slice(
    section.indexOf("    steps:\n") + "    steps:\n".length,
  );
  return body
    .split(/^(?= {6}- )/m)
    .filter((chunk) => chunk.startsWith("      - "))
    .map((chunk) => ({
      text: chunk,
      name: chunk.match(/^ {6}- name: (.+)$/m)?.[1] ?? "",
      id: chunk.match(/^ {8}id: (\S+)$/m)?.[1],
      condition: chunk.match(/^ {8}if: (.+)$/m)?.[1],
    }));
}

/** The `run: |` script of a step, dedented. */
function script(step: Step): string {
  const lines = step.text.split("\n");
  const at = lines.findIndex((line) => /^ {8}run: \|$/.test(line));
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

const DEPENDABOT = "dependabot[bot]";

/**
 * Run the token step's shell with `token` as the secret ('' = absent) on a
 * pull request opened by `author`.
 */
function runTokenStep(job: string, token: string, author: string) {
  const step = steps(job).find((s) => s.id === "token");
  if (!step) throw new Error(`${job} has no step with id: token`);
  const dir = mkdtempSync(join(tmpdir(), "review-token-"));
  try {
    const out = join(dir, "output");
    const result = spawnSync("bash", ["-e", "-c", script(step)], {
      env: {
        PATH: process.env["PATH"] ?? "",
        CLAUDE_CODE_OAUTH_TOKEN: token,
        PR_AUTHOR: author,
        GITHUB_OUTPUT: out,
      },
      encoding: "utf8",
    });
    let outputs = "";
    try {
      outputs = readFileSync(out, "utf8");
    } catch {
      /* no output written */
    }
    return { ...result, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const JOBS = ["code-review", "security-review"];

for (const job of JOBS) {
  describe(job, () => {
    it("asks about the credential first, from the secret through env only", () => {
      const [first] = steps(job);
      expect(first?.id).toBe("token");
      expect(first?.condition).toBeUndefined();
      expect(first?.text).toContain(
        "CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      );
      // The secret is never interpolated into the script itself.
      expect(script(first as Step)).not.toContain("secrets.");
    });

    it("gates every other step on the answer, and keeps the assertion running only then", () => {
      const rest = steps(job).slice(1);
      expect(rest.length).toBeGreaterThan(3);
      for (const step of rest) {
        expect(step.condition, `${job}: "${step.name}" is not gated`).toContain(
          "steps.token.outputs.available != 'false'",
        );
      }
      const assertion = rest.find((s) =>
        s.text.includes("scripts/assert-review-ran.mjs"),
      );
      expect(assertion?.condition).toBe(
        "always() && steps.token.outputs.available != 'false'",
      );
      // The review step is what actually uses the token, and it is gated too.
      expect(rest.some((s) => s.text.includes("claude-code-action"))).toBe(
        true,
      );
    });

    it("takes the author through env, never interpolated into the script", () => {
      const step = steps(job)[0] as Step;
      expect(step.text).toContain(
        "PR_AUTHOR: ${{ github.event.pull_request.user.login }}",
      );
      expect(script(step)).not.toContain("${{");
    });

    // Timeout: spawns bash on the workflow step (4 ms quiet); 15 s.
    it("skips with a notice naming #244 only for Dependabot with no token", { timeout: 15_000 }, () => {
      const run = runTokenStep(job, "", DEPENDABOT);
      expect(run.status).toBe(0);
      expect(run.outputs.trim()).toBe("available=false");
      expect(run.stdout).toMatch(/^::notice title=.* skipped::/m);
      expect(run.stdout).toContain("#244");
      expect(run.stdout).toContain("CLAUDE_CODE_OAUTH_TOKEN is not available");
      expect(run.stdout).not.toContain("::warning");
    });

    // Timeout: spawns bash on the workflow step (6 ms quiet); 15 s.
    it("reviews Dependabot when the token is present, so a Dependabot secret turns reviews on", { timeout: 15_000 }, () => {
      const run = runTokenStep(job, "sekret-value-123", DEPENDABOT);
      expect(run.status).toBe(0);
      expect(run.outputs.trim()).toBe("available=true");
      expect(run.stdout).not.toContain("::notice");
      expect(run.stdout).not.toContain("::warning");
    });

    // Timeout: spawns bash on the workflow step (14 ms quiet); 15 s.
    it("keeps reviewing, and warns, when anyone else has no token, so the red stays red", { timeout: 15_000 }, () => {
      for (const author of ["stevemarvell", "dependabot-preview[bot]", ""]) {
        const run = runTokenStep(job, "", author);
        expect(run.status).toBe(0);
        expect(run.outputs.trim(), `author "${author}"`).toBe("available=true");
        expect(run.stdout).toMatch(/^::warning title=.*::/m);
        expect(run.stdout).toContain("CLAUDE_CODE_OAUTH_TOKEN is missing");
        expect(run.stdout).not.toContain("::notice");
      }
    });

    // Timeout: spawns bash on the workflow step (4 ms quiet); 15 s.
    it("reviews anyone else with a token, silently", { timeout: 15_000 }, () => {
      const run = runTokenStep(job, "sekret-value-123", "stevemarvell");
      expect(run.status).toBe(0);
      expect(run.outputs.trim()).toBe("available=true");
      expect(run.stdout).not.toContain("::notice");
      expect(run.stdout).not.toContain("::warning");
    });

    // Timeout: spawns bash on the workflow step (15 ms quiet); 15 s.
    it("never prints the secret, present or absent", { timeout: 15_000 }, () => {
      for (const token of ["sekret-value-123", ""]) {
        for (const author of [DEPENDABOT, "stevemarvell"]) {
          const run = runTokenStep(job, token, author);
          expect(run.stdout + run.stderr + run.outputs).not.toContain(
            "sekret-value-123",
          );
        }
      }
    });
  });
}

describe("the gate reads the same in both jobs", () => {
  it("uses the same token step script in both", () => {
    const [a, b] = JOBS.map(
      (job) => steps(job).find((s) => s.id === "token") as Step,
    );
    // Only the words "Code"/"code" vs "Security"/"security" differ.
    const norm = (s: string) =>
      s
        .replace(/Code review|Security review/g, "X")
        .replace(/\b(code|security) review/g, "x");
    expect(norm(script(a as Step))).toBe(norm(script(b as Step)));
  });
});
