#!/usr/bin/env node
// The harness a work or review job installs (action.yml): the one the Objective's `pendulum:harness:<name>` label names,
// read with the job's own token before the install, so the job installs that CLI rather than the repository's default.
// Only the label's name is read here: the stage checks who applied it and Blocks when the harness it runs on is not the
// one this job installed (objective-trust.mjs choiceGate, PENDULUM_STAGE_HARNESS).
//   node scripts/objective-harness.mjs --repo OWNER/NAME (--issue N | --branch pendulum/N)
// Writes `harness=<name>` to $GITHUB_OUTPUT: empty when no single harness label names one, or the read failed. The review
// job names its PR's branch (GITHUB_HEAD_REF, from the event): no pull request read, which its token may not be allowed.
//   node scripts/objective-harness.mjs --resolve <harness> --workflow-harness <name>
// The exact CLI version the install step installs for <harness> (choice.mjs resolveHarnessVersion), printed alone on
// stdout, its reason in the job log; when none can be chosen, nothing on stdout and `version_problem` ({reason, fix}) in
// $GITHUB_OUTPUT, which the stage Blocks on (objective-trust.mjs choiceGate) before any harness runs.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { choiceOf, resolveHarnessVersion } from "./lib/choice.mjs";
import { getIssue, repoOf } from "./lib/github.mjs";
import { CLI } from "./lib/harness.mjs";
import { harnessMinAgeDays, input, log, logTo, parseArgs, setOutput } from "./lib/inputs.mjs";

/**
 * The harness the Objective's labels name, or "" for the repository's default: its issue (`issue`, or the one a
 * pendulum/<issue> `branch` is for) through choice.mjs choiceOf. `read` (issue) is a test's own.
 */
export async function labelHarness({ repo, issue = null, branch = "", opts, read = {} }) {
  const n = Number(issue) || Number(/^pendulum\/(\d+)$/.exec(String(branch || ""))?.[1]) || null;
  if (!n) return "";
  const c = choiceOf((await (read.issue ?? getIssue)(repo, n, opts))?.labels || []);
  return c.ok && c.choice.harness ? c.choice.harness : "";
}

/**
 * The version a job installs for `harness` (resolveHarnessVersion over the job's harness_version and
 * harness_min_age_days, as `input` reads them: the action's `with:`, else the workflow's env block), logged with why.
 */
export async function installVersion({ harness, workflowHarness, env = process.env, registry, now }) {
  const pkg = CLI[harness]?.pkg;
  if (!pkg) return { problem: { reason: `unknown harness ${harness}`, fix: "Set PENDULUM_HARNESS to claude, codex or copilot." } };
  const r = await resolveHarnessVersion({ harness, pkg, spec: input("harness_version", { env }), workflowHarness, minAgeDays: harnessMinAgeDays(input("harness_min_age_days", { env })), registry, now });
  log(r.problem ? `harness ${harness}: no version installed: ${r.problem.reason}` : `harness ${harness}: ${pkg}@${r.version}, ${r.why}`);
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ("resolve" in args) {
    logTo(process.stderr);
    const r = await installVersion({ harness: String(args.resolve), workflowHarness: String(args.workflow_harness || "") });
    if (r.problem && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version_problem=${JSON.stringify(r.problem)}\n`);
    if (r.version) process.stdout.write(`${r.version}\n`);
    return;
  }
  let harness = "";
  try {
    harness = await labelHarness({ repo: repoOf(args.repo || process.env.GITHUB_REPOSITORY), issue: args.issue, branch: args.branch, opts: { token: process.env.GITHUB_TOKEN } });
  } catch (e) {
    log(`warning: the Objective's harness label could not be read (${String(e?.message || e).slice(0, 160)}); installing the repository's default, and the stage Blocks if its label names another`);
  }
  setOutput("harness", harness);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
