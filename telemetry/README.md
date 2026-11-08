# Telemetry

Closes the `aia1` gap recorded in the issue tracker: *nothing
measures token use, active time, or output per merged change.*

Claude Code emits OpenTelemetry metrics and events. This directory is the
collector that catches them — OTLP in, Prometheus in the middle, one Grafana
dashboard on top.

```
claude ──OTLP/gRPC:4317──▶ otel-collector ──:8889──▶ prometheus ──▶ grafana:3000
```

By default every port is bound to loopback and nothing leaves the machine. Two
things deliberately change that, and both are opt-in:

- the **cloud overlay** below, which also forwards to Grafana Cloud
- the **GitHub Actions runs**, which cannot reach this laptop and so report to
  Grafana Cloud directly

Neither is on until a credential exists.

## The number this exists to produce

**Tokens per merged pull request.** Token spend on its own says nothing — it
falls when you do less and rises when you do more. Divided by merged changes it
becomes a rate, and a rate can be compared week to week. `claude_code.active_time.total`
is the second axis: it separates *this took a lot of tokens* from *this took a
lot of me*.

## Running it

```bash
cd telemetry
cp .env.example .env        # then set your own Grafana admin credentials
docker compose up -d
```

Then **restart Claude Code**. The exporter settings are read when a session
starts, so the session you are sitting in when you first pull this will not be
reporting — that is the setting not being live yet, not the stack being broken.

Grafana is at <http://localhost:3000>, dashboard **Claude Code — cost of the
loop**. Prometheus is at <http://localhost:9090> if you want to poke at raw
series. Metrics land within `OTEL_METRIC_EXPORT_INTERVAL` (10s), and counters
need two exports before `increase()` has anything to say — a brand new stack
looks empty for the first half-minute. That is the stack working, not failing.

`docker compose down` stops it; `docker compose down -v` also discards the
90 days of history.

## What is switched on, and what is not

[`../.claude/settings.json`](../.claude/settings.json) carries the exporter
config, so the setting is visible to everyone working here rather than living
in somebody's shell profile — the same rule the deployment config follows.

**Events on, content off.** `OTEL_LOGS_EXPORTER=otlp` is set, because Grafana
Cloud's Claude Code integration reads events as well as metrics and its
dashboards are half empty without them.

The line that matters is one step further in. Events on their own carry
*metadata* — which tool ran, how long it took, which model, which session.
Three separate variables turn them into the prompts and file contents
themselves:

```
OTEL_LOG_USER_PROMPTS      # your prompts
OTEL_LOG_TOOL_DETAILS      # tool inputs
OTEL_LOG_TOOL_CONTENT      # file contents read and written
```

**None of them is set anywhere in this repository, and none should be.** Unset
is off. They are deliberately absent rather than set to `0`, because `"0"` is a
truthy string in more places than it ought to be and absence cannot be
misread.

This is what that gap meant by *"prompts, responses and tool inputs are
redacted by default; leave them that way"* — the redaction is those three flags,
not the pipe itself. Shutting the pipe entirely would be stricter than the
rule asks and would cost the integration's dashboards their event data.

The collector also deletes `user.email`, `user.id`, `user.account_uuid`,
`user.account_id` and `organization.id` before anything is stored **locally**. A
single-developer stack does not need to know who the developer is, and metric
labels are forever. The cloud pipelines deliberately do not scrub — see
"Identity follows the destination, not the source" below for why scrubbing there
made the shared store *less* accurate rather than more private.

That scrub takes **two** processors, `resource/scrub` and `attributes/scrub`,
and the duplication is load-bearing. Claude Code sends identity as *resource*
attributes; the `attributes` processor only sees datapoint attributes; and
`resource_to_telemetry_conversion` promotes resource attributes to Prometheus
labels inside the exporter, which runs after every processor. A config carrying
only the `attributes` processor reads as though it scrubs and does not — a
test payload can arrive in Prometheus labelled `user_email="steve@example.com"`
with no error anywhere. If you edit these processors, re-run the check below.

`add_metric_suffixes: false` on the Prometheus exporter keeps the names as
Claude Code spells them — `claude_code_token_usage`, not
`claude_code_token_usage_tokens_total`. The dashboard queries the short names.

## Checking it works

```bash
docker compose up -d && ./check.sh
```

`check.sh` pushes one synthetic payload through the collector and asserts what
Prometheus ends up holding: that the metric names survive unsuffixed, and that
the identity attributes are gone. Both failure modes are silent otherwise — a
suffixed name shows up as a dashboard full of "No data" with nothing visibly
wrong, and a failed scrub shows up as nothing at all until someone reads the
labels.

## No Docker? Start here instead

The console exporter costs nothing and needs none of the above. It prints the
metrics to the terminal, which is enough to decide whether standing up the
stack is worth it:

```bash
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=console \
  OTEL_METRIC_EXPORT_INTERVAL=10000 claude
```

## Credentials

`.env` is gitignored. `.env.example` is the template, and it holds placeholders
only — this repository is public, so a password committed here is a password
published here.

## The unattended runs

Claude also runs in GitHub Actions — `claude-code-review.yml` on every pull
request, and `claude.yml` whenever someone tags `@claude`. That is the spend
least likely to be noticed, because nobody is sitting there while it happens.

`claude-code-action` passes the nine OTel variables through from `env` (see
its `action.yml`); if a workflow does not set them, CI telemetry is not
failing quietly against `localhost` — it is simply off.

Both workflows set them. A runner cannot reach the collector on this
laptop, so CI ships straight to Grafana Cloud, and the overlay above sends local
metrics to the same place. One store, both sources, told apart by
`OTEL_RESOURCE_ATTRIBUTES`:

| Attribute | Laptop | CI |
| --- | --- | --- |
| `environment` | unset | `ci` |
| `workflow` | unset | `claude-code-review` or `claude-mention` |
| `run_id`, `run_attempt` | unset | the GitHub run |

Without that split, tokens per merged PR quietly absorbs the review bot and
stops meaning what the panel title says.

The settings are not exported as environment variables, because **a settings
file beats the process environment** — "Claude Code writes each `env` entry
into the process environment, replacing the value inherited from the shell"
(<https://code.claude.com/docs/en/env-vars>). `.claude/settings.json` is checked
out on the runner along with everything else, and it points
`OTEL_EXPORTER_OTLP_ENDPOINT` at `http://localhost:4317` for the benefit of a
laptop. Exporting Grafana Cloud's endpoint as a workflow env var would have the
checked-out file overwrite it, and every run would ship its metrics to a port
nothing is listening on. Nothing fails visibly: the job stays green, the
credential is present, the log is clean, and the dashboard is empty.

`scripts/write-ci-telemetry-settings.mjs` writes a settings file instead, and
the session loads it with `--settings` in `claude_args`. That flag outranks
even a project-local file
(<https://code.claude.com/docs/en/settings>), so a value in it arrives
regardless of the committed `.claude/settings.json` — and it sidesteps a
second limit too: `claude-code-action` forwards exactly nine `OTEL_*`
variables from `env` into the CLI, and
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` is not among them. A value
in a settings file arrives regardless of which nine the action forwards.

Writing to `.claude/settings.local.json` instead looks tempting: *project
local* outranks the committed `.claude/settings.json`. That is true and still
not enough: `claude-code-action` checks out a pull request's head to review
it, and because that content is untrusted, it deletes and restores `.claude`
(along with `.mcp.json`, `CLAUDE.md` and a few other paths) from the base
branch immediately before the CLI starts. A `.claude/settings.local.json`
written by an earlier workflow step is gone by the time Claude Code reads it,
and CI falls back to the committed `localhost:4317` again — silently, the
same way as the process-environment trap above, findable only by reading
Grafana Cloud's own attributes: every session in the store, CI runs
included, would carry `terminal_type=windows-terminal` and no `environment`
label at all. Writing the file to `$RUNNER_TEMP` and loading it with
`--settings` keeps it outside the checkout entirely, where that restore never
looks.

Two deliberate choices in that script:

- **Gated on the credential.** `CLAUDE_CODE_ENABLE_TELEMETRY` is `1` only when
  both secrets are set, and the file is written *either way*: with no block at
  all the committed `localhost:4317` would apply and the run would spend its
  life retrying a connection to itself.
- **5s export interval, not 10.** A runner is destroyed the moment the job
  ends, and a flush on exit is not documented. A short review could otherwise
  finish between exports and report nothing at all.

### Checking it actually arrives

Every telemetry failure here is silent by construction: a failed OTLP export
writes nothing to the Actions log, so a broken runner and a working one
produce the same green job and the same clean log. Wrong temporality, the
checked-out `settings.json` overriding the endpoint, and the action deleting
`.claude` before the CLI started have all hidden behind that, and each is
found the same way and could not be found any other way: **read the store's
own attributes, never the config.**

Grafana Cloud, Explore, the `grafanacloud-…-prom` datasource, a 7-day window.
Ask what is actually in there rather than opening a dashboard, which will show
"No data" identically whether the metric is missing, misnamed, or never sent:

```promql
count by (environment, terminal_type) ({__name__=~"claude_code.*"})
```

What the answer means:

| Result | Reading |
| --- | --- |
| A series with `environment="ci"` | CI telemetry is arriving. This is the one that matters. |
| Only `terminal_type="windows-terminal"`, no `environment` | Laptop sessions only. CI is silent — the checked-out-settings or restored-`.claude` failure mode above. |
| Nothing at all | Nothing is reaching the store, laptop included. Check the credential and the overlay before suspecting CI. |

To pin it to one run, narrow by the attributes
`write-ci-telemetry-settings.mjs` sets — `workflow` is
`claude-code-review`, `claude-security-review` or `claude-mention`, and
`run_id` is the GitHub run:

```promql
claude_code_token_usage_tokens_total{environment="ci", run_id="<the run>"}
```

One expected gap that is **not** a fault: `claude_code_pull_request_count` has
no series for a review run. Claude Code emits it only when a session itself
opens a pull request, and a reviewer does not. Misreading that particular "No
data" is expensive, because tokens per merged pull request is the panel this
whole directory exists to produce.

### Switching it on

Grafana Cloud ships a **Claude Code integration** — Connections, the Claude Code
tile, Install. It provisions **one** dashboard, "Claude Code", with an Overview
section (cost, tokens, sessions, active users, cost by model and by team member,
API latency, OS/arch/terminal/version) and a Productivity section (lines of
code, commits, pull requests, active time, session outcome). It is better than
a cloud copy of the local dashboard, which is why this repository does not
ship one.

1. Grafana Cloud Portal, your stack, the **OpenTelemetry** tile, Configure.
   Generate a token; it prints the `OTEL_*` variables ready-made.
2. Install the **Claude Code** integration from Connections.
3. Set two repository secrets:
   - `GRAFANA_CLOUD_OTLP_ENDPOINT` — the endpoint, ending `/otlp`
   - `GRAFANA_CLOUD_OTLP_AUTH` — the whole `OTEL_EXPORTER_OTLP_HEADERS` value,
     `Authorization=Basic <base64>`
4. Put the same credential in `.env` and run the overlay, so this repository's
   sessions reach the same store. The spelling differs between the two — see
   `.env.example`. This is no longer optional if the number is meant to mean
   anything; see "Every session, one store" below.

Until step 3, both workflows run with telemetry off, exactly as before.

### Every session, one store

Settings merge with the project winning, and that is the trap. A machine-wide
`~/.claude/settings.json` pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at Grafana
Cloud covers every project — except one that sets the same key itself.
[`../.claude/settings.json`](../.claude/settings.json) sets it to
`http://localhost:4317`, so sessions *in this repository* reach the local
collector and nothing else. Left there, the repository that built the telemetry
is the only one missing from the store it built — which is exactly what
happened: the cloud dashboard read one session and one active user while this
project's entire history sat on the laptop.

The overlay is what closes it. Sessions here keep pointing at the local
collector, and the collector fans out — Prometheus for offline history, Grafana
Cloud so every source lands in one place.

One consequence worth knowing: with the overlay off, or Docker down, a session
in this repository reports **nowhere**, while a session in any other project
still reaches Grafana Cloud directly. The local collector is a single point of
failure for this project's telemetry alone.

### Identity follows the destination, not the source

The collector deletes `user.email`, `user.id`, `user.account_uuid`,
`user.account_id` and `organization.id` on the way to Prometheus, and does not
on the way to Grafana Cloud. That asymmetry is deliberate, and it is a
correction rather than a compromise.

Scrubbing the cloud export protected nothing. Every other Claude Code session on
this machine reports to Grafana Cloud *directly* from `~/.claude/settings.json`,
carrying `user.email`, and so does every GitHub Actions run — the store already
holds that address. Stripping it from this one source did not remove it from
anywhere; it split one person into two. Observed on the integration dashboard
the moment the overlay was switched on: "Cost by team member" read
`Value $0.57` next to a real address at `$0.49`, and "Active users" said 2 for
one human.

So the local store stays anonymous, because a single-developer Prometheus does
not need to know who the developer is and metric labels are forever. The shared
store gets the label it already has everywhere else, because an aggregate that
double-counts is worse than one that identifies.

`check.sh`'s canary is the exception that proves the rule. It pushes a synthetic
payload carrying `canary@example.com` to assert the local scrub works, and the
cloud pipelines drop anything whose `service.name` is `claude-code-check` —
otherwise the canary would arrive in the shared store as a second team member
who does not exist.

### The variable that decides whether any of it works

`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative`, required by the
integration and set in all three places here.

Claude Code can emit *delta* temporality. A Prometheus-backed store — Grafana
Cloud's, and the local one — drops delta sums on the floor. There is no error,
no warning, and nothing in any log: the panels simply read "No data", which
looks exactly like a wrong metric name, a broken scrape, or a session that never
reported. It went unnoticed here until Grafana's own integration docs spelled it
out.

<https://code.claude.com/docs/en/monitoring-usage>
