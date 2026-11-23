import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/sops-rules.md is the short page implementers load; docs/sops.md holds
// the reasoning (#331). Nothing else ties the two together, so a SOP added to
// one and not the other would go unnoticed.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const sopHeadings = (text: string) => text.split("\n").filter((l) => /^## SOP \d+:/.test(l));
// GitHub's anchor for a heading: lowercased, punctuation dropped, spaces to hyphens.
const slug = (heading: string) =>
  heading.replace(/^#+\s*/, "").toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s/g, "-");

describe("docs/sops-rules.md", () => {
  const sops = read("docs/sops.md");
  const rules = read("docs/sops-rules.md");

  it("is at most 1,200 words", () => {
    expect(rules.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1200);
  });

  it("has the same SOP headings, in the same order, as docs/sops.md", () => {
    const full = sopHeadings(sops);
    expect(full.length).toBeGreaterThanOrEqual(10);
    expect(sopHeadings(rules)).toEqual(full);
  });

  it("links each section to the matching heading in docs/sops.md", () => {
    const anchors = sopHeadings(sops).map(slug);
    for (const anchor of anchors) {
      expect(rules, anchor).toContain(`(sops.md#${anchor})`);
    }
  });

  it("carries every row of the declared-ceilings table", () => {
    const rows = (text: string) => text.split("\n").filter((l) => /^\| /.test(l) && l.includes("|"));
    const ceilings = rows(sops.slice(sops.indexOf("### The declared ceilings"), sops.indexOf("### What enforces this")));
    expect(ceilings.length).toBeGreaterThan(5);
    for (const row of ceilings) expect(rules, row).toContain(row);
  });

  it("is pointed at by docs/sops.md", () => {
    expect(sops).toContain("docs/sops-rules.md");
  });

  // Facts both pages state (#418). Each failure names the SOP and both values.
  // Values are derived from sops.md where it holds the source (a table), not
  // typed in here.
  const section = (text: string, n: number) => {
    const start = text.indexOf(`## SOP ${n}:`);
    const end = text.indexOf("\n## SOP ", start + 1);
    expect(start, `SOP ${n} missing`).toBeGreaterThanOrEqual(0);
    return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
  };
  const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

  it("SOP 3: the inert-control count matches the table, and the rules page agrees if it states one", () => {
    const sop3 = sops.slice(sops.indexOf("## SOP 3:"), sops.indexOf("## SOP 4:"));
    const tableRows = sop3.split("\n").filter((l) => /^\| /.test(l)).length - 2; // header and rule
    const count = (text: string) => {
      const m = /\b(\w+) controls in this repository\b/i.exec(text.replace(/\s+/g, " "));
      return m ? WORDS.indexOf((m[1] ?? "").toLowerCase()) + 1 : null;
    };
    expect(tableRows).toBeGreaterThan(0);
    expect(count(sop3), `SOP 3: sops.md prose count vs ${tableRows} table rows`).toBe(tableRows);
    const stated = count(section(rules, 3));
    if (stated !== null) expect(stated, `SOP 3: sops.md has ${tableRows}, sops-rules.md says ${stated}`).toBe(tableRows);
  });

  it("SOP 4: both pages give the same per-agent token cost", () => {
    const range = (text: string) => {
      const m = /(\d+k)(?:–|-| to )(\d+k) tokens/.exec(text);
      return m ? `${m[1]}–${m[2]}` : null;
    };
    const full = range(section(sops, 4));
    expect(full, "SOP 4: no token range found in sops.md").not.toBeNull();
    expect(range(section(rules, 4)), `SOP 4: sops.md says ${full}`).toBe(full);
  });

  it("SOP 4: both pages give the same CLAUDE.md length target", () => {
    const target = (text: string) => /under (\d+) lines/.exec(text)?.[1] ?? null;
    const full = target(section(sops, 4));
    expect(full, "SOP 4: no line target in sops.md").not.toBeNull();
    expect(target(section(rules, 4)), `SOP 4: sops.md says ${full}`).toBe(full);
  });

  it("SOP 5: both pages name the same labels and the rules page repeats each definition", () => {
    const labels = ["critical", "high", "medium"] as const;
    const full = section(sops, 5);
    const short = section(rules, 5).toLowerCase();
    expect([...full.matchAll(/\| `(\w+)` \|/g)].map((m) => m[1]), "SOP 5: label table in sops.md").toEqual([...labels]);
    expect(short, "SOP 5: sops-rules.md label list").toContain("`critical`, `high` or `medium`");
    const defines: Record<(typeof labels)[number], string> = {
      critical: "wrong answers, real exposure, or work blocked",
      high: "a real defect, bounded today by something written down",
      medium: "nothing is wrong while it waits",
    };
    for (const label of labels) {
      const row = new RegExp(`\\| \`${label}\` \\| ([^|]*) \\|`).exec(full)?.[1] ?? "";
      expect(row.toLowerCase(), `SOP 5: sops.md ${label} row`).toContain(defines[label]);
      expect(short, `SOP 5: sops-rules.md ${label} definition`).toContain(`\`${label}\`: ${defines[label]}`);
    }
  });

  // Whole references, so "#15" is not satisfied by "#153".
  const refs = (text: string) => new Set(text.match(/#\d+\b/g) ?? []);
  const missingRefs = (short: string, full: string) => [...refs(short)].filter((r) => !refs(full).has(r));

  it("every issue number the rules page cites is also in sops.md", () => {
    expect(missingRefs(rules, sops), "issue numbers in sops-rules.md but not sops.md").toEqual([]);
  });

  it("matches issue numbers whole: #15 is not satisfied by #153", () => {
    expect(missingRefs("see #15", "decided in #153")).toEqual(["#15"]);
    expect(missingRefs("see #153", "decided in #153")).toEqual([]);
  });
});
