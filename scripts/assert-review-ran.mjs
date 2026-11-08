// Fail the review job when no review was produced, and say which way it
// failed.
//
// This exists because the review job's green tick can mean nothing, in three
// different ways.
//
// 1. `claude-code-action` refuses to run at all when the pull request changes
//    the workflow file, because the file has to be byte-identical to the copy
//    on the default branch. It logs "Exiting due to workflow validation skip",
//    posts nothing, and *leaves the job green*. So the one class of change
//    most worth a security review — a change to CI, its token permissions, or
//    an action pin — is the class this reviewer structurally cannot review.
// 2. The session ends with `is_error: true`, and the job's own log says "No
//    buffered inline comments" — nothing reached the pull request.
// 3. The action starts no session for its own reasons, on a pull request that
//    changes no workflow file. From inside the log this is indistinguishable
//    from 1 — both have no log at all — which is why the scope job's answer
//    about the changed files is passed in rather than guessed at here.
//
// None can be fixed from here: the first is the action's own rule and the
// other two are a session failing to start or to finish. What can be fixed is
// the silence. A reviewer that produced nothing is not a reviewer that found
// nothing, and this repository watches for exactly that shape of defect: a
// control that ran, reported success, and did not do its job. This one says
// so, and says so specifically rather than blaming the same cause every time
// regardless of which one actually applied.
//
// Case 2 above is not one case but two. A session that ends with
// `is_error: true` can still have posted a completed review before it
// errored, or it can have stopped at an unticked first step and posted
// nothing. `is_error: true` is where the session ended, not what it
// produced, and reading it as "posted nothing" is an inference the log does
// not support on its own. The log holds the messages, so the messages are
// what gets read.
import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Did a review session actually run to a result?
 *
 * `execution` is the parsed contents of the action's execution log; `null`
 * when there is no file to parse — which is itself the loudest signal, since
 * it means no session started — or `UNREADABLE` when a file was written but
 * did not parse. Those two are kept apart on purpose: they fail the job the
 * same way but have different causes, and a check that names the wrong cause
 * sends whoever reads it to the wrong place.
 *
 * `workflowChanged` is the scope job's answer to "does this pull request
 * touch `.github/workflows/`", and `null` when the scope job could not say.
 * With no session and no log, blaming the workflow-file rule every time
 * would be wrong whenever a different workflow-unrelated cause stopped the
 * session. Three answers, three messages — the rule stated as fact when it
 * applies, ruled out when it does not, and offered as the likely cause only
 * when nobody knows.
 *
 * A session that ended with `is_error: true` is read the same way: the whole
 * message array, not just the result, because the result says where the
 * session stopped and the messages say what it produced on the way. See
 * `reviewEvidence`.
 */
export function reviewVerdict({
  kind = 'code',
  conclusion = '',
  execution = null,
  workflowChanged = null,
} = {}) {
  const messages = Array.isArray(execution) ? execution : [];
  const result = messages.findLast?.((message) => message?.type === 'result') ?? null;

  if (execution === UNREADABLE) {
    return {
      ok: false,
      headline: `The ${kind} review left a log that could not be read`,
      detail:
        'The action wrote an execution log but it did not parse as JSON, so whether a review happened cannot be established from here. Treat the pull request as unreviewed and read the job log by hand.',
    };
  }

  if (execution === null) {
    return {
      ok: false,
      headline: `No ${kind} review ran on this pull request`,
      detail: `The action produced no execution log, so no session started. ${noSessionCause(workflowChanged)}`,
    };
  }

  if (result === null) {
    return {
      ok: false,
      headline: `The ${kind} review did not finish`,
      detail:
        'The execution log holds no result message, so the session was cut off rather than ending with a verdict.',
    };
  }

  if (result.is_error === true) {
    const produced = reviewEvidence(messages);
    if (produced) {
      return {
        ok: false,
        headline: `The ${kind} review errored after producing ${produced}`,
        detail: `The session ended with \`is_error: true\` after ${result.num_turns ?? 'an unknown number of'} turns, but the execution log shows it had already produced ${produced} before it fell over. So this is not an unreviewed pull request: read the tracking comment on it, decide whether what is there is complete enough to trust, and re-run the job only if it is not. The job still fails, because a session that fell over may have stopped short of what the rubric asks.`,
      };
    }
    return {
      ok: false,
      headline: `The ${kind} review errored and posted nothing`,
      detail: `The session ended with \`is_error: true\` after ${result.num_turns ?? 'an unknown number of'} turns. This is a failure of the run, not a finding about the change — treat the pull request as unreviewed rather than as clean.`,
    };
  }

  if (conclusion && conclusion !== 'success') {
    return {
      ok: false,
      headline: `The ${kind} review reported \`${conclusion}\``,
      detail: 'The session reached a result but the action did not call it a success.',
    };
  }

  return {
    ok: true,
    headline: `The ${kind} review ran to a verdict`,
    detail: `${result.num_turns ?? 0} turns. The verdict is on the pull request, in the tracking comment.`,
  };
}

/**
 * Why no session started, given what the scope job knows about the changed
 * files. The three answers send the reader to three different places, which
 * is the whole point: the workflow rule is checkable, and stating it when it
 * does not hold costs somebody a diff of a file nobody touched.
 */
function noSessionCause(workflowChanged) {
  if (workflowChanged === true) {
    return 'This pull request changes a file under `.github/workflows/`, and `claude-code-action` requires the workflow to be byte-identical to the copy on the default branch: it exits early rather than running. A pull request that changes CI is the one class of change this reviewer cannot review — review it by hand, and re-read it on the pull request after this one.';
  }
  if (workflowChanged === false) {
    return 'This pull request changes no file under `.github/workflows/`, so the workflow-validation rule is not the cause and there is no workflow diff to go looking for. The action failed to start a session for its own reasons — the job log above is the only record of why. Treat the pull request as unreviewed and re-run the job.';
  }
  return 'The scope job did not report whether this pull request touches `.github/workflows/`, so the cause cannot be narrowed from here. The usual one is that rule: `claude-code-action` requires the workflow to be byte-identical to the copy on the default branch and exits early otherwise. If no workflow file changed, read the job log instead.';
}

/**
 * The two tools by which a review session puts something on the pull request.
 * Neither name is guessed: the inline-comment tool is the one named in
 * `--allowedTools` in `claude-code-review.yml`, and the tracking-comment tool
 * is what `track_progress: true` adds — the action prints both as
 * `ALLOWED_TOOLS` in this job's own log.
 */
const INLINE_COMMENT_TOOL = 'mcp__github_inline_comment__create_inline_comment';
const TRACKING_COMMENT_TOOL = 'mcp__github_comment__update_claude_comment';

/**
 * A verdict is a line that *begins* with the word, which is the shape both
 * rubrics produce and the shape the prompt asks for ("End your final message
 * with the one-line verdict the rubric asks for"), for example
 * `**Verdict: this belongs on \`develop\` as it stands.**`.
 *
 * Deliberately narrow, and narrow in the safe direction. Matching "would
 * merge" or "belongs on develop" anywhere in the session's own chatter would
 * put this script back to inferring — a first-turn "I'll work out whether I'd
 * merge this" is not a verdict. A verdict this misses degrades to the message
 * below, which is where this check already was; a verdict it invents is a new
 * false claim on a pull request, which is the defect being fixed.
 */
const VERDICT_LINE = /^[ \t>*_#-]*verdict\b[^\n]*\S/im;

/**
 * The ids of tool calls that came back an error.
 *
 * This is the one thing worth reading out of a tool *result*, and it does not
 * reopen what the comment below rules out. That rule is about content the
 * session was *shown* and could be echoing — the rubric's wording, the diff,
 * another pull request's comments. `is_error` is not content: it is the other
 * end's answer to whether the call worked, and it is the only record of that
 * anywhere in the log.
 *
 * It matters because `create_inline_comment` fails routinely — GitHub rejects
 * a review comment on a line that is not part of the diff, an easy mistake
 * for a reviewer working from a truncated hunk. Counting that call would have
 * this check announce "errored after producing 1 inline comment" and send
 * somebody to a pull request with no comment on it — the same false claim
 * one turn further in. A control observed by "it was called" rather than
 * "it worked" is this repository's signature defect, and this script exists
 * to catch exactly that.
 *
 * A call with no result at all is left counted, deliberately. The session
 * died in flight and the log does not say which side of the call it died on,
 * so "go and read the tracking comment" stays the cheaper answer of the two —
 * nothing is asserted about what is in that comment either way.
 */
function rejectedCalls(messages) {
  const rejected = new Set();
  for (const message of messages) {
    const content = message?.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'tool_result' && block.is_error === true && block.tool_use_id) {
        rejected.add(block.tool_use_id);
      }
    }
  }
  return rejected;
}

/**
 * What the session demonstrably produced before it stopped, as a phrase, or
 * `null` when the log shows nothing reaching the pull request.
 *
 * Only `assistant` messages are read. A tool *result* is something the session
 * was shown — the rubric file, the diff, another pull request's comments — and
 * all three of those contain the word "verdict"; reading them would find a
 * verdict in a session that never wrote one.
 */
function reviewEvidence(messages) {
  const rejected = rejectedCalls(messages);
  let inlineComments = 0;
  let verdict = false;

  for (const message of messages) {
    if (message?.type !== 'assistant') continue;
    const content = message.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text') {
        if (VERDICT_LINE.test(String(block.text ?? ''))) verdict = true;
      } else if (block?.type === 'tool_use') {
        // A call the other end refused put nothing on the pull request, so it
        // is not evidence of one — see `rejectedCalls`.
        if (rejected.has(block.id)) continue;
        if (block.name === INLINE_COMMENT_TOOL) inlineComments += 1;
        // The body the session wrote into the tracking comment is the
        // strongest evidence there is: it is the text a person reading the
        // pull request will find. The checklist the action keeps in that same
        // comment mentions "verdict" as an unticked item — `- [ ] Post
        // findings and verdict` — which is why the pattern is line-anchored.
        if (block.name === TRACKING_COMMENT_TOOL) {
          if (VERDICT_LINE.test(String(block.input?.body ?? ''))) verdict = true;
        }
      }
    }
  }

  const posted = inlineComments === 1 ? '1 inline comment' : `${inlineComments} inline comments`;
  if (verdict && inlineComments > 0) return `a verdict and ${posted}`;
  if (verdict) return 'a verdict';
  if (inlineComments > 0) return posted;
  return null;
}

/**
 * A log that exists but does not parse. Distinct from `null`, which means the
 * action wrote no log at all.
 */
export const UNREADABLE = Symbol('unreadable execution log');

/**
 * A workflow output read back as a tri-state: `true`, `false`, or `null` for
 * anything else. A job that died leaves its outputs empty, and empty must not
 * read as `false` — that is how a check ends up stating something it does not
 * know.
 */
export function readFlag(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * Read and parse the action's execution log: `null` when there is no file,
 * `UNREADABLE` when there is one that will not parse.
 */
export function readExecution(path) {
  if (!path) return null;
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return UNREADABLE;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const kind = process.env['KIND'] || 'code';
  const verdict = reviewVerdict({
    kind,
    conclusion: process.env['CONCLUSION'] ?? '',
    execution: readExecution(process.env['EXECUTION_FILE'] ?? ''),
    workflowChanged: readFlag(process.env['WORKFLOW_CHANGED']),
  });

  const summary = process.env['GITHUB_STEP_SUMMARY'];
  // Never echo the execution log itself: it carries tool output, which on this
  // runner includes the environment of a job holding two credentials.
  const block = `### ${verdict.headline}\n\n${verdict.detail}\n`;
  if (summary) appendFileSync(summary, `${block}\n`);
  console.log(block);

  if (!verdict.ok) {
    console.log(`::warning title=${verdict.headline}::${verdict.detail}`);
    process.exit(1);
  }
}
