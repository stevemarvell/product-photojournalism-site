import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
// Collapse line wraps and list indentation so a phrase is found wherever it wraps.
const read = (p: string) => readFileSync(resolve(root, p), 'utf8').replace(/\s+/g, ' ');

describe('stop rules use the SOP 6 recoverability test', () => {
  it('ship.md does not stop for what was merely not asked', () => {
    const s = read('.claude/commands/ship.md');
    expect(s).not.toContain('beyond what was asked');
    expect(s).toContain('work nobody can get back, money, or anything reaching a third party');
    expect(s).toContain('SOP 6');
  });

  it('implementer.md stops for exactly the SOP 6 reasons and decides open questions', () => {
    const s = read('.claude/agents/implementer.md');
    expect(s).toContain(
      '(work nobody can get back, a dashboard behind a login, money, a credential, or an action reaching a third party)',
    );
    const stop = /If the task turns out to need a person.*?stop there/.exec(s)?.[0] ?? '';
    expect(stop).not.toBe('');
    expect(stop).not.toMatch(/decision|open question|left open|leaves open/i);
    expect(s).toContain('Decisions made');
    expect(s).toContain('A decision the issue leaves open is yours');
  });

  it('delegate skill reads the decisions when the work comes back', () => {
    expect(read('.claude/skills/delegate/SKILL.md')).toContain('Decisions made');
  });
});
