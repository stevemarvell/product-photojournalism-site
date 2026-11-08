import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNREADABLE,
  readExecution,
  readFlag,
  reviewVerdict,
} from '../assert-review-ran.mjs';

const finished = (extra: Record<string, unknown> = {}) => [
  { type: 'system', subtype: 'init' },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 11, ...extra },
];

// The stream-json shapes the action writes to claude-execution-output.json.
const assistant = (...content: unknown[]) => ({
  type: 'assistant',
  message: { id: 'msg_01', type: 'message', role: 'assistant', content },
});
const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (name: string, input: Record<string, unknown>, id = 'toolu_01') => ({
  type: 'tool_use',
  id,
  name,
  input,
});
// `extra` carries what the other end said back: a different `tool_use_id`, or
// `is_error: true` for a call it refused.
const toolResult = (content: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content, ...extra }],
  },
});

// A realistic pair of tracking comments from a run where both reviews
// errored and this check said the same thing about both of them, abridged
// in the middle and not at either end — the verdict line and the unticked
// checklist are the whole point, so they are verbatim.
const TRACKING_COMMENT = 'mcp__github_comment__update_claude_comment';
const INLINE_COMMENT = 'mcp__github_inline_comment__create_inline_comment';

const erroredAfterItsVerdict = () => [
  { type: 'system', subtype: 'init' },
  assistant(toolUse('Read', { file_path: '.claude/agents/security-checker.md' })),
  toolResult('Then one line: does this change belong on `develop` as it stands.'),
  assistant(
    toolUse(TRACKING_COMMENT, {
      body: [
        '### Security review of PR #112 — exposure',
        '',
        '- [x] Read `CLAUDE.md`, `docs/sops.md`, `docs/data-governance.md`',
        '- [x] Get the diff (`gh pr diff 112`)',
        '- [x] Post inline findings, ranked',
        '- [x] Final verdict',
        '',
        '**No findings.**',
        '',
        'This PR touches none of the controls `docs/data-governance.md` relies on',
        '— no GraphQL, no depth limit, no rate limiter, no CORS.',
        '',
        '**Verdict: this belongs on `develop` as it stands.**',
      ].join('\n'),
    }),
  ),
  { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 8 },
];

const erroredBeforeIt = () => [
  { type: 'system', subtype: 'init' },
  assistant(toolUse('Read', { file_path: 'CLAUDE.md' })),
  assistant(
    toolUse(TRACKING_COMMENT, {
      body: [
        '### Reviewing PR #112',
        '',
        '- [x] Read `CLAUDE.md` and `docs/sops.md`',
        '- [x] Read `.claude/agents/code-checker.md` rubric',
        '- [ ] Get diff (`gh pr diff 112`)',
        '- [ ] Review `scripts/test-census.mjs` and `.d.mts`',
        '- [ ] Post findings and verdict',
      ].join('\n'),
    }),
  ),
  { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 4 },
];

describe('reviewVerdict', () => {
  it('passes a session that reached a verdict', () => {
    expect(reviewVerdict({ conclusion: 'success', execution: finished() }).ok).toBe(true);
  });

  it('fails when there is no execution log at all', () => {
    // The workflow-validation skip: the action exits before starting a session
    // and leaves the job green. Run 34814234791 did exactly this — sixteen
    // seconds, success, no review — on a pull request that changed CI.
    const verdict = reviewVerdict({ kind: 'security', conclusion: '', execution: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.headline).toContain('security');
    expect(verdict.detail).toContain('.github/workflows/');
  });

  it('fails a session that ended with is_error', () => {
    // Three of the twenty runs before this script existed did, and the job log
    // reads "No buffered inline comments" — nothing reached the pull request.
    const verdict = reviewVerdict({ execution: finished({ is_error: true }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('unreviewed');
  });

  it('does not say a review posted nothing when the log shows it posted a verdict', () => {
    // A security review can write its completed checklist, its reasoning
    // and `Verdict: this belongs on develop as it stands.` into the tracking
    // comment, and *then* fall over. Telling somebody that pull request is
    // unreviewed costs a re-run that produces the review already sitting on
    // it.
    const verdict = reviewVerdict({ kind: 'security', execution: erroredAfterItsVerdict() });
    expect(verdict.ok).toBe(false);
    expect(verdict.headline).not.toContain('posted nothing');
    expect(verdict.detail).not.toContain('treat the pull request as unreviewed');
    expect(verdict.headline).toContain('verdict');
    expect(verdict.detail).toContain('tracking comment');
  });

  it('keeps the unreviewed message for a session that errored before it reviewed anything', () => {
    // The other half of the same run: the code review's checklist stops at an
    // unticked `[ ] Get diff`. Nothing about this case changed, and the
    // unticked `- [ ] Post findings and verdict` line must not read as one.
    const verdict = reviewVerdict({ execution: erroredBeforeIt() });
    expect(verdict.ok).toBe(false);
    expect(verdict.headline).toBe('The code review errored and posted nothing');
    expect(verdict.detail).toContain('treat the pull request as unreviewed');
  });

  it('says the two cases differently', () => {
    const after = reviewVerdict({ execution: erroredAfterItsVerdict() });
    const before = reviewVerdict({ execution: erroredBeforeIt() });
    expect(after.headline).not.toBe(before.headline);
    expect(after.detail).not.toBe(before.detail);
  });

  it('counts inline findings a session posted before it errored', () => {
    // No verdict line anywhere — the session was cut off before writing one —
    // but two findings are on the pull request either way.
    const verdict = reviewVerdict({
      execution: [
        assistant(toolUse(INLINE_COMMENT, { path: 'scripts/test-census.mjs', line: 41, body: 'a' })),
        assistant(toolUse(INLINE_COMMENT, { path: 'scripts/test-census.mjs', line: 76, body: 'b' })),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 6 },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('2 inline comments');
    expect(verdict.detail).not.toContain('treat the pull request as unreviewed');
  });

  it('does not mistake a verdict it was shown for a verdict it wrote', () => {
    // The rubric it reads, the diff it fetches and the pull request's own
    // comments all contain the word. A tool result is what the session was
    // handed, not what it produced, and reading one would put this check back
    // to inferring — which is the defect, not the fix.
    const verdict = reviewVerdict({
      execution: [
        assistant(toolUse('Bash', { command: 'gh pr view 112' })),
        toolResult('**Verdict: this belongs on `develop` as it stands.**'),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3 },
      ],
    });
    expect(verdict.headline).toBe('The code review errored and posted nothing');
  });

  it('does not count an inline comment the other end refused', () => {
    // `create_inline_comment` fails routinely: GitHub rejects a review comment
    // on a line that is not part of the diff. The call is in the log either
    // way, and counting it would have this check announce a finding and send
    // somebody to a pull request with nothing on it. "It was called" is not
    // "it worked".
    const verdict = reviewVerdict({
      execution: [
        assistant(toolUse(INLINE_COMMENT, { path: 'scripts/ports.mjs', line: 4, body: 'a' })),
        toolResult('line 4 is not part of the diff', { is_error: true }),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 5 },
      ],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.headline).toBe('The code review errored and posted nothing');
    expect(verdict.detail).toContain('treat the pull request as unreviewed');
  });

  it('counts the findings that landed and not the ones that did not', () => {
    // Two calls, one refused. The pull request carries one comment, so that is
    // the number — not two, and not none.
    const verdict = reviewVerdict({
      execution: [
        assistant(toolUse(INLINE_COMMENT, { path: 'a.mjs', line: 4, body: 'a' }, 'toolu_01')),
        toolResult('line 4 is not part of the diff', { is_error: true }),
        assistant(toolUse(INLINE_COMMENT, { path: 'b.mjs', line: 9, body: 'b' }, 'toolu_02')),
        toolResult('created', { tool_use_id: 'toolu_02' }),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 7 },
      ],
    });
    expect(verdict.detail).toContain('1 inline comment');
    expect(verdict.detail).not.toContain('2 inline comments');
  });

  it('does not count a verdict the tracking-comment call failed to write', () => {
    // The body of that call is the strongest evidence there is *because* it is
    // the text a person reading the pull request finds. If the call was
    // refused, that text is nowhere — the session wrote it, the comment never
    // got it, and the reader must not be sent to look for it.
    const verdict = reviewVerdict({
      kind: 'security',
      execution: [
        assistant(
          toolUse(TRACKING_COMMENT, {
            body: '**Verdict: this belongs on `develop` as it stands.**',
          }),
        ),
        toolResult('comment not found', { is_error: true }),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 9 },
      ],
    });
    expect(verdict.headline).toBe('The security review errored and posted nothing');
  });

  it('fails a log that never reached a result', () => {
    const verdict = reviewVerdict({ execution: [{ type: 'system', subtype: 'init' }] });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('cut off');
  });

  it('names the workflow rule only when a workflow file actually changed', () => {
    // A security review with no execution log and no workflow-file change
    // should not send the reader off to diff a workflow file that pull
    // request never touched. The scope job knows the answer; it is passed
    // in.
    const blamed = reviewVerdict({ execution: null, workflowChanged: true });
    expect(blamed.ok).toBe(false);
    expect(blamed.detail).toContain('byte-identical');
    // Stated as fact, not as "the usual cause" — the job checked.
    expect(blamed.detail).not.toContain('usual cause');
  });

  it('rules the workflow rule out when no workflow file changed', () => {
    const verdict = reviewVerdict({ execution: null, workflowChanged: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).not.toContain('byte-identical');
    expect(verdict.detail).toContain('job log');
  });

  it('hedges only when the scope job could not say', () => {
    // A scope job that died leaves the output empty. Unknown must read as
    // unknown: naming a cause nobody established is the defect being fixed.
    const verdict = reviewVerdict({ execution: null, workflowChanged: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('usual');
    expect(verdict.detail).toContain('byte-identical');
  });

  it('says something different in each of the three cases', () => {
    const details = [true, false, null].map(
      (workflowChanged) => reviewVerdict({ execution: null, workflowChanged }).detail,
    );
    expect(new Set(details).size).toBe(3);
  });

  it('fails when the action itself did not call it a success', () => {
    const verdict = reviewVerdict({ conclusion: 'failure', execution: finished() });
    expect(verdict.ok).toBe(false);
    expect(verdict.headline).toContain('failure');
  });

  it('never leaks the execution log into what it prints', () => {
    // The log carries tool output, and this job's environment holds the Claude
    // OAuth token and the Grafana credentials.
    const secret = 'sk-ant-oat-notarealtoken';
    const verdict = reviewVerdict({
      execution: finished({ is_error: true, result: `failed while reading ${secret}` }),
    });
    expect(`${verdict.headline} ${verdict.detail}`).not.toContain(secret);
  });

  it('does not leak the verdict it found either', () => {
    // The errored-after-a-verdict branch reads message content to decide what
    // to say. What it says is still a count and a phrase, never the text — the
    // tracking comment is where a person reads the review.
    const secret = 'sk-ant-oat-notarealtoken';
    const verdict = reviewVerdict({
      execution: [
        assistant(text(`**Verdict:** would merge, once ${secret} is out of the workflow file.`)),
        { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 9 },
      ],
    });
    expect(verdict.detail).toContain('verdict');
    expect(`${verdict.headline} ${verdict.detail}`).not.toContain(secret);
  });

  it('defaults to failing rather than to passing', () => {
    // Called with nothing at all — no log, no conclusion — it must not report
    // that a review happened.
    expect(reviewVerdict().ok).toBe(false);
  });
});

describe('readFlag', () => {
  it('reads a workflow output back as true, false or unknown', () => {
    expect(readFlag('true')).toBe(true);
    expect(readFlag('false')).toBe(false);
  });

  it('does not read a missing output as false', () => {
    // A job that did not run leaves its outputs empty, and `false` here would
    // make this check state that no workflow file changed on the strength of
    // a job that never looked.
    for (const missing of [undefined, '', 'TRUE', 'yes', 'null']) {
      expect(readFlag(missing)).toBeNull();
    }
  });
});

let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('readExecution', () => {
  it('returns null for a path that is empty or missing', () => {
    expect(readExecution('')).toBeNull();
    expect(readExecution('/no/such/claude-execution-output.json')).toBeNull();
  });

  it('separates a log that will not parse from a log that is not there', () => {
    dir = mkdtempSync(join(tmpdir(), 'review-'));
    const path = join(dir, 'claude-execution-output.json');
    writeFileSync(path, 'Exiting due to workflow validation skip');

    // Both fail the job, but not for the same reason, and the reader is sent
    // to a different place by each.
    expect(readExecution(path)).toBe(UNREADABLE);

    const unreadable = reviewVerdict({ execution: UNREADABLE });
    const absent = reviewVerdict({ execution: null });
    expect(unreadable.ok).toBe(false);
    expect(absent.ok).toBe(false);
    expect(unreadable.headline).not.toBe(absent.headline);
    // The absent case blames the workflow-file rule. The unparseable one must
    // not, because that is a different failure with a different fix.
    expect(unreadable.detail).not.toMatch(/byte-identical/);
    expect(absent.detail).toMatch(/byte-identical/);
  });
});
