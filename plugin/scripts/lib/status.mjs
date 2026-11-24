// `pendulum status` (#652): the repository's open issues as one read-only triage view. Ordinary issues by owner (no
// assignee: "needs an owner", with the evidence; assigned: who, and the open PRs GitHub links to it), the Objectives by
// state, and each parent's GitHub sub-issues with their progress, the blocked children by number and link with the
// reason Pendulum's own Blocked notice records, and what could not be read as unknown. Reads only, within a call budget
// (report.mjs Budget), through the GitHub client (github.mjs rest and graphql: retries, rate limits, outages). It writes
// nothing, starts nothing and judges no issue ready: admission stays the pendulum-file skill's explicit Start a draft.
// Issue titles and notice text are untrusted: printed as one plain line each, never followed.

import { graphql, rest } from "./github.mjs";
import { Budget, BudgetStop, paged } from "./report.mjs";
import { blockCauseOf, setSelf, stateOf } from "./logic.mjs";
import { pendulumOwn } from "./finish-card.mjs";
import { DRAFT_LABEL } from "./stop.mjs";
import { LOCAL_LABEL } from "./local.mjs";

/** The view's JSON schema: its name and major version. */
export const STATUS_SCHEMA = "pendulum-status/1";
/** The default ceiling on GitHub API calls (`--max-calls`). */
export const STATUS_MAX_CALLS = 100;
/** Where an ordinary issue goes to become an Objective: an explicit step, never this view's. */
export const ADMISSION = "the pendulum-file skill, Start a draft (plugin/skills/pendulum-file/reference.md#start-a-draft)";
/** Issues per linked-PR query (one GraphQL call each). */
const LINK_BATCH = 50;

const names = (issue) => (issue?.labels || []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
/** Untrusted text as one plain line: control characters and line breaks become spaces, clipped. */
export const plain = (s, max = 200) => {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const repoOfUrl = (url, fallback) => /\/repos\/([^/]+\/[^/]+)$/.exec(String(url || ""))?.[1] ?? fallback;
const httpWhy = (e) => (e?.status ? `HTTP ${e.status}` : plain(e?.message, 80) || "read failed");

/** An open issue's Pendulum state: Draft, or its state label's (logic.mjs stateOf, no board), or Queued; closed: Done. */
const objectiveState = (i) => (i.state === "closed" ? "Done" : names(i).includes(DRAFT_LABEL) ? "Draft" : stateOf(i, null));

/**
 * Read the view of `repo` ({owner, name, full}) within `maxCalls` GitHub calls: `token`, `appId` (Pendulum's App, whose
 * notices count as Pendulum's own beside the token's login), `objectiveLabel`. A call budget stop keeps what was read
 * and leaves the rest unknown (`stoppedAt`). Every request is a GET or a GraphQL query.
 */
export async function readStatus(repo, { token, appId = null, objectiveLabel = "pendulum:objective", maxCalls = STATUS_MAX_CALLS, log = () => {} } = {}) {
  const budget = new Budget(maxCalls, log);
  const opts = { token };
  const view = { schema: STATUS_SCHEMA, repo: repo.full, needsOwner: [], assigned: [], objectives: [], parents: [], admission: ADMISSION, unknown: [], stoppedAt: null, calls: 0 };
  const isObjective = (i) => names(i).includes(objectiveLabel) || names(i).includes(DRAFT_LABEL);
  const blocked = new Map();
  try {
    // Pendulum's own login, so its Blocked notices are told from a paste; a failed read leaves only the App's.
    budget.take("user");
    try {
      const u = await rest("user", opts);
      if (u?.login) setSelf(u.type === "Bot" && !u.login.endsWith("[bot]") ? `${u.login}[bot]` : u.login);
    } catch (e) {
      if (e instanceof BudgetStop) throw e;
      view.unknown.push(`the token's own login (${httpWhy(e)}): only notices through Pendulum's App count as Pendulum's`);
    }
    const open = (await paged(`repos/${repo.full}/issues?state=open`, budget, "issues", opts)).filter((i) => !i.pull_request);
    const ordinary = open.filter((i) => !isObjective(i));
    const row = (i) => ({ number: i.number, title: plain(i.title), url: i.html_url, labels: names(i) });
    const prs = new Map(ordinary.map((i) => [i.number, null]));
    for (const i of open) {
      if (isObjective(i)) {
        const o = { ...row(i), state: objectiveState(i), route: names(i).includes(LOCAL_LABEL) ? "local" : "action", blockedReason: null };
        view.objectives.push(o);
        if (o.state === "Blocked") blocked.set(`${repo.full}#${i.number}`, { repo: repo.full, number: i.number, rows: [o] });
      } else {
        const assignees = (i.assignees || []).map((a) => a.login);
        const r = { ...row(i), assignees, linkedPrs: null };
        if (assignees.length) view.assigned.push(r);
        // No assignee: needs an owner, and nothing more; never ready on that evidence.
        else view.needsOwner.push({ ...r, evidence: ["no assignee", `no ${objectiveLabel} label`] });
      }
    }
    if (open.some((i) => !i.sub_issues_summary)) view.unknown.push("sub-issues of the issues GitHub gave no sub-issue summary for");
    for (const p of open.filter((i) => i.sub_issues_summary?.total > 0)) {
      const s = p.sub_issues_summary;
      view.parents.push({ ...row(p), owner: isObjective(p) ? "pendulum" : (p.assignees || []).map((a) => a.login), total: s.total, completed: s.completed ?? null, children: [], blocked: [], unknown: s.total, unknownWhy: "not read (call budget)" });
    }
    // The open PRs GitHub links to each ordinary issue (closing references), one GraphQL query per LINK_BATCH issues.
    const numbers = [...prs.keys()];
    for (let at = 0; at < numbers.length; at += LINK_BATCH) {
      const batch = numbers.slice(at, at + LINK_BATCH);
      budget.take("linked prs");
      try {
        const fields = batch.map((n) => `i${n}: issue(number: ${n}) { closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number url isDraft state } } }`).join(" ");
        const d = await graphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner: repo.owner, name: repo.name }, opts);
        for (const n of batch) {
          const nodes = d?.repository?.[`i${n}`]?.closedByPullRequestsReferences?.nodes;
          if (Array.isArray(nodes)) prs.set(n, nodes.filter((x) => x?.state === "OPEN").map((x) => ({ number: x.number, url: x.url, draft: !!x.isDraft })));
        }
      } catch (e) {
        if (e instanceof BudgetStop) throw e;
        view.unknown.push(`the linked PRs of ${batch.map((n) => `#${n}`).join(", ")} (${httpWhy(e)})`);
      }
    }
    for (const r of [...view.assigned, ...view.needsOwner]) r.linkedPrs = prs.get(r.number);
    for (const p of view.parents) {
      let kids;
      try {
        kids = await paged(`repos/${repo.full}/issues/${p.number}/sub_issues`, budget, "sub-issues", opts);
      } catch (e) {
        if (e instanceof BudgetStop) throw e;
        p.unknownWhy = `unreadable (${httpWhy(e)})`;
        continue;
      }
      for (const k of kids) {
        const kidRepo = repoOfUrl(k.repository_url, repo.full);
        const objective = isObjective(k);
        const c = { number: k.number, repo: kidRepo, title: plain(k.title), url: k.html_url, state: k.state, kind: objective ? "objective" : "ordinary", pendulumState: objective ? objectiveState(k) : null, assignees: (k.assignees || []).map((a) => a.login), blockedReason: null };
        p.children.push(c);
        if (c.pendulumState === "Blocked") {
          p.blocked.push(c);
          const key = `${kidRepo}#${k.number}`;
          if (!blocked.has(key)) blocked.set(key, { repo: kidRepo, number: k.number, rows: [] });
          blocked.get(key).rows.push(c);
        }
      }
      // What the summary counts and the list did not give (another repository's issue this token cannot read, say).
      p.unknown = Math.max(0, p.total - p.children.length);
      p.unknownWhy = p.unknown ? "counted by GitHub, not readable with this token" : null;
    }
    // Each Blocked Objective's reason: the newest Blocked notice of Pendulum's own, never anyone else's.
    const own = pendulumOwn(appId);
    for (const b of blocked.values()) {
      let why = "no Blocked notice of Pendulum's own";
      let reason = null;
      try {
        const comments = await paged(`repos/${b.repo}/issues/${b.number}/comments`, budget, "comments", opts);
        const notice = comments.filter((c) => own(c) && String(c.body || "").startsWith(`<!-- pendulum:${b.number}:blocked:`)).at(-1);
        const line = notice && /^Blocked \(([^)\n]*)\): ([^\n]*)/m.exec(notice.body);
        if (line) reason = { stage: plain(line[1], 40), cause: blockCauseOf(notice.body), text: plain(line[2], 300), url: notice.html_url ?? null };
      } catch (e) {
        if (e instanceof BudgetStop) throw e;
        why = `comments unreadable (${httpWhy(e)})`;
      }
      for (const r of b.rows) r.blockedReason = reason ?? { unknown: why };
    }
  } catch (e) {
    if (!(e instanceof BudgetStop)) throw e;
    view.stoppedAt = e.message;
  }
  for (const r of [...view.objectives, ...view.parents.flatMap((p) => p.blocked)]) if (r.state === "Blocked" || r.pendulumState === "Blocked") r.blockedReason ??= { unknown: "not read (call budget)" };
  view.calls = budget.made;
  return view;
}

const link = (r) => `#${r.number}${r.url ? ` (${r.url})` : ""}`;
const prsText = (prs) => (prs === null ? "linked PRs unknown" : prs.length ? `linked PR ${prs.map((p) => `#${p.number}${p.draft ? " (draft)" : ""} ${p.url}`).join(", ")}` : "no linked PR");
const reasonText = (r) => (r?.unknown ? `reason unknown: ${r.unknown}` : r ? `Blocked (${r.stage}${r.cause ? `, cause ${r.cause}` : ""}): ${r.text}` : "reason unknown");

/** The view as plain Markdown for a terminal. */
export function renderStatus(v) {
  const out = [`# ${v.repo}: open issues (read-only)`, ""];
  out.push("## Needs an owner", "");
  if (!v.needsOwner.length) out.push("None.");
  for (const r of v.needsOwner) out.push(`- ${link(r)} ${r.title}: needs an owner (${r.evidence.join("; ")}; ${prsText(r.linkedPrs)})`);
  out.push("", `Not a claim that any is ready. To hand one to Pendulum: ${v.admission}.`, "", "## Assigned", "");
  if (!v.assigned.length) out.push("None.");
  for (const r of v.assigned) out.push(`- ${link(r)} ${r.title}: ${r.assignees.join(", ")}; ${prsText(r.linkedPrs)}`);
  out.push("", "## Objectives", "");
  if (!v.objectives.length) out.push("None.");
  for (const o of v.objectives) out.push(`- ${link(o)} ${o.title}: ${o.state}, ${o.route}${o.state === "Blocked" ? `; ${reasonText(o.blockedReason)}` : ""}`);
  out.push("", "## Parents", "");
  if (!v.parents.length) out.push("None.");
  for (const p of v.parents) {
    out.push(`- ${link(p)} ${p.title}: ${p.completed ?? "unknown"} of ${p.total} sub-issues done; ${p.blocked.length} blocked`);
    for (const c of p.children) {
      const ref = c.repo === v.repo ? `#${c.number}` : `${c.repo}#${c.number}`;
      const what = c.kind === "objective" ? `Objective, ${c.pendulumState}` : `${c.state}, ${c.assignees.length ? c.assignees.join(", ") : "no assignee"}`;
      out.push(`  - ${ref} (${c.url}) ${c.title}: ${what}${c.pendulumState === "Blocked" ? `; ${reasonText(c.blockedReason)}` : ""}`);
    }
    if (p.unknown) out.push(`  - ${p.unknown} sub-issue(s) unknown: ${p.unknownWhy}`);
  }
  if (v.unknown.length) out.push("", "## Unknown", "", ...v.unknown.map((u) => `- ${u}`));
  if (v.stoppedAt) out.push("", `Partial: ${v.stoppedAt}; a higher --max-calls reads the rest.`);
  out.push("", `${v.calls} GitHub calls, no writes.`, "");
  return out.join("\n");
}
