/**
 * Documentation topic: SRE theory mapped to SRE Capsule screens.
 */
export const SRE_THEORY_DOC_HTML = `
<article class="about-doc about-doc-wide">
  <h2>From SRE theory to SRE Capsule</h2>
  <p class="about-lead">
    Each practice below is the industry meaning first, then the exact place and gesture in SRE Capsule.
    The product records what happened. It does not invent a cause, and it does not call Slack, Jira, or a cluster unless a workflow you already enabled does that on ingest.
  </p>

  <h3>Detect</h3>
  <p>An incident starts when a signal says the service or the test is no longer doing what it should. The clock for response starts at detection, not when a person notices.</p>
  <p><strong>In SRE Capsule.</strong> CI posts a failure to the gateway webhook (<code>X-API-Key</code>, <code>X-Run-Id</code>). The row appears on <strong>Telemetry Stream</strong> with <em>Detected</em> set to <code>created_at</code>.</p>

  <h3>Acknowledge</h3>
  <p>Acknowledgement means a named person has taken the incident. Severity says how badly it hurts users, not how loud the log is. A second person does not replace the first owner.</p>
  <p><strong>In SRE Capsule.</strong> Open the incident. A lead or manager picks <em>sev1</em> to <em>sev4</em> and clicks <strong>Acknowledge</strong>. The timeline then shows who took it. If nobody does that for 15 minutes, the row says <em>Waiting N min for an owner</em>.</p>

  <h3>Mitigate, then resolve</h3>
  <p>Mitigation stops the user impact. Resolution means the incident is closed and the record is complete. They are different moments.</p>
  <p><strong>In SRE Capsule.</strong> <strong>Mark mitigated</strong> writes the mitigate time. <strong>Resolve</strong> on the pipeline card closes the incident. The line reads Detected, Acknowledged, Mitigated, Resolved.</p>

  <h3>One incident for the same cause</h3>
  <p>A spike should be one incident with a count, not a new page for every identical failure. The originals stay available for the audit.</p>
  <p><strong>In SRE Capsule.</strong> On Telemetry Stream, failures of the same gateway and the same test (or the same fingerprint) inside 6 hours fold into one row. The badge lists the signal numbers and times. The database rows are not deleted.</p>

  <h3>Change failure and the error budget</h3>
  <p>DORA change-failure rate is failed changes divided by all changes in the window. An error budget is how many of those failures you agreed to spend. Burn rate is failures used divided by failures allowed. At 1× the budget is gone. Crossing the line is a warning to slow down, not a switch that blocks the pipeline by itself.</p>
  <table class="about-table">
    <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td>No runs</td><td>Nothing was deployed in the window.</td></tr>
      <tr><td>Within budget</td><td>Burn is under 0.8×.</td></tr>
      <tr><td>Close to budget</td><td>Burn is from 0.8× up to 1×.</td></tr>
      <tr><td>Freeze deploys</td><td>Burn is 1× or more. This is a decision on screen, not an enforced block.</td></tr>
    </tbody>
  </table>
  <p><strong>In SRE Capsule.</strong> Managers open <strong>DORA</strong>. The error-budget table shows runs, failed runs, budget left, and burn. The SLO is the allowed failure rate for that gateway, from 1% to 50%. <strong>Save</strong> stores it on the gateway. The default is 15%.</p>

  <h3>The change that sits next to the incident</h3>
  <p>Most incidents are easier to read next to the deploy that just landed. A change far from the incident is context, not a cause.</p>
  <p><strong>In SRE Capsule.</strong> Each pipeline card shows the nearest deploy: commit, branch, outcome, and how many minutes before the incident. The remediation graph for that gateway is edited in the <strong>Workflow</strong> section.</p>

  <h3>Runbook</h3>
  <p>A runbook is a known sequence for a known symptom. You confirm it. You do not let a matcher fire a production action because a word appeared in a log.</p>
  <p><strong>In SRE Capsule.</strong> <strong>Runbook</strong> on the incident asks the plugin engine which catalog steps match (502, OOM, flaky, timeout, regression). The confirmation names those steps. Saving records the dry-run on the incident. Slack, Jira, and the cluster are not called from this button. A symptom with no matching step is left alone.</p>

  <h3>Postmortem</h3>
  <p>A postmortem is the chronology of what was recorded, written after the incident is closed, so the next one is shorter. A missing fact stays missing.</p>
  <p><strong>In SRE Capsule.</strong> After resolve, <strong>Write postmortem</strong> drafts from the timeline, comments, and the nearest deploy. If AI is enabled, the model may rewrite that draft and is told not to add a cause, a person, or a time that is not already there. If AI is off or does not answer, the factual draft is saved. <strong>Save draft</strong> keeps your edit.</p>

  <h3 data-doc-anchor="maintenance">Maintenance</h3>
  <p>A maintenance window says the team already knows why the gateway may fail. Hiding those incidents would erase the record. Marking them keeps the queue honest.</p>
  <p><strong>In SRE Capsule.</strong> On DORA, under the error budget, a manager sets gateway, reason, and 1 to 24 hours, then <strong>Start</strong>. Telemetry Stream shows a banner. Incidents that start during the window stay in the list and carry the reason. <strong>End</strong> closes the window. One open window per gateway.</p>

  <h3>Where to click</h3>
  <table class="about-table">
    <thead><tr><th>Practice</th><th>Screen</th><th>Who</th></tr></thead>
    <tbody>
      <tr><td>Detect, acknowledge, mitigate, same cause, runbook, postmortem</td><td>Telemetry Stream</td><td>Lead or manager for the buttons. Everyone with access can read.</td></tr>
      <tr><td>Error budget, SLO, maintenance</td><td>DORA</td><td>Manager</td></tr>
      <tr><td>AI rewrite of the postmortem</td><td>AI Configuration, then Telemetry Stream</td><td>Manager turns the provider on. Lead writes the draft.</td></tr>
    </tbody>
  </table>
</article>`;
