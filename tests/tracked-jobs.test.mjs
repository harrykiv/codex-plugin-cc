import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { resolveJobsDir, resolveJobLogFile } from "../plugins/codex/scripts/lib/state.mjs";

function makeJob(workspaceRoot) {
  const logFile = resolveJobLogFile(workspaceRoot, "t1"); // ensures the jobs dir exists
  fs.writeFileSync(logFile, "[2026-06-02] starting\n[2026-06-02] working\n");
  return {
    id: "t1", workspaceRoot, title: "t", summary: "s", logFile,
    jobClass: "task", createdAt: new Date().toISOString(),
  };
}

function readJobRecord(workspaceRoot) {
  return JSON.parse(fs.readFileSync(path.join(resolveJobsDir(workspaceRoot), "t1.json"), "utf8"));
}

test("runTrackedJob writes failure.json + records failureFile on non-zero exit", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  await runTrackedJob(
    job,
    async () => ({ exitStatus: 1, payload: {}, rendered: "boom", summary: "boom" }),
    { logFile: job.logFile }
  );
  const fp = path.join(resolveJobsDir(ws), "t1.failure.json");
  assert.ok(fs.existsSync(fp), "failure.json should exist");
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(rec.status, "failed");
  assert.equal(rec.exitCode, 1);
  assert.equal(rec.reasonClass, "nonzero_exit");
  assert.ok(Array.isArray(rec.lastLogLines) && rec.lastLogLines.length > 0);
  assert.equal(readJobRecord(ws).failureFile, fp);
});

test("runTrackedJob writes failure.json + records failureFile when the runner throws", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  await assert.rejects(
    runTrackedJob(job, async () => { throw new Error("kaboom"); }, { logFile: job.logFile })
  );
  const fp = path.join(resolveJobsDir(ws), "t1.failure.json");
  assert.ok(fs.existsSync(fp));
  const rec = JSON.parse(fs.readFileSync(fp, "utf8"));
  assert.equal(rec.reasonClass, "exception");
  assert.match(rec.message, /kaboom/);
  assert.equal(readJobRecord(ws).failureFile, fp);
});

test("runTrackedJob classifies common failure reasons best-effort", async () => {
  const cases = [
    ["request timed out after 30s", "timeout"],
    ["job was cancelled by user", "cancelled"],
    ["spawn codex ENOENT", "spawn_failed"],
    ["api error: 429 rate limit", "api_error"],
    ["something unexpected", "exception"],
  ];
  for (const [message, expected] of cases) {
    const ws = makeTempDir();
    const job = makeJob(ws);
    await assert.rejects(runTrackedJob(job, async () => { throw new Error(message); }, { logFile: job.logFile }));
    const rec = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(ws), "t1.failure.json"), "utf8"));
    assert.equal(rec.reasonClass, expected, `message="${message}"`);
  }
});

test("a failure.json write error does not mask the original failure", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).endsWith(".failure.json")) throw new Error("disk full");
    return realWrite(p, ...rest);
  };
  try {
    await assert.rejects(
      runTrackedJob(job, async () => { throw new Error("kaboom"); }, { logFile: job.logFile }),
      /kaboom/
    );
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(readJobRecord(ws).status, "failed");
});

test("failure.json lastLogLines includes the final rendered output on non-zero exit", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  await runTrackedJob(
    job,
    async () => ({ exitStatus: 1, payload: {}, rendered: "FINAL_OUTPUT_MARKER_XYZ", summary: "boom" }),
    { logFile: job.logFile }
  );
  const rec = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(ws), "t1.failure.json"), "utf8"));
  assert.ok(
    rec.lastLogLines.some((l) => l.includes("FINAL_OUTPUT_MARKER_XYZ")),
    `expected final output in lastLogLines, got: ${JSON.stringify(rec.lastLogLines)}`
  );
});

test("a final-output log append failure does not mask the runner's terminal outcome", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => { throw new Error("disk full"); };
  try {
    // non-zero runner -> must still be recorded as failed (NOT thrown), and must not reject
    await runTrackedJob(job, async () => ({ exitStatus: 1, payload: {}, rendered: "x", summary: "boom" }), { logFile: job.logFile });
  } finally {
    fs.appendFileSync = realAppend;
  }
  assert.equal(readJobRecord(ws).status, "failed");
});

test("a persistence error does not reclassify an already-written failure record", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  const realWrite = fs.writeFileSync;
  // The success path writes t1.failure.json (reasonClass nonzero_exit) BEFORE the
  // t1.json job record. Allow the initial running-record write and the failure
  // record write, then throw on the *post-failure-record* t1.json write so control
  // reaches the catch with a failure.json already present. The catch must NOT
  // overwrite/reclassify it.
  let sawFailureRecord = false;
  fs.writeFileSync = (p, ...rest) => {
    if (String(p).endsWith("/t1.failure.json")) {
      sawFailureRecord = true;
      return realWrite(p, ...rest);
    }
    if (sawFailureRecord && String(p).endsWith("/t1.json")) throw new Error("state write failed");
    return realWrite(p, ...rest);
  };
  try {
    await assert.rejects(
      runTrackedJob(
        job,
        async () => ({ exitStatus: 1, payload: {}, rendered: "x", summary: "boom" }),
        { logFile: job.logFile }
      )
    );
  } finally {
    fs.writeFileSync = realWrite;
  }
  const rec = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(ws), "t1.failure.json"), "utf8"));
  assert.equal(rec.reasonClass, "nonzero_exit");
});

test("readLastLogLines preserves a large single-line tail (only the marker is not enough)", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  fs.writeFileSync(job.logFile, "[2026] " + "Z".repeat(80000)); // one huge line, no newline
  // Empty rendered keeps the "Final output" append a no-op (appendLogBlock returns on
  // empty body), so the log reaches readLastLogLines as a genuine single-line tail.
  await runTrackedJob(job, async () => ({ exitStatus: 1, payload: {}, rendered: "", summary: "boom" }), { logFile: job.logFile });
  const rec = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(ws), "t1.failure.json"), "utf8"));
  // more than just the truncation marker: some "Z" content survives
  assert.ok(rec.lastLogLines.some((l) => l.includes("ZZZ")), `got: ${JSON.stringify(rec.lastLogLines).slice(0, 200)}`);
});

test("failure.json lastLogLines is bounded and marked truncated for a large log", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  const big = Array.from({ length: 6000 }, (_, i) => `[2026] line ${i}`).join("\n") + "\n";
  fs.writeFileSync(job.logFile, big);
  assert.ok(fs.statSync(job.logFile).size > 65536);
  await runTrackedJob(job, async () => ({ exitStatus: 1, payload: {}, rendered: "done", summary: "boom" }), { logFile: job.logFile });
  const rec = JSON.parse(fs.readFileSync(path.join(resolveJobsDir(ws), "t1.failure.json"), "utf8"));
  assert.ok(rec.lastLogLines.length <= 21, `expected <=21 lines, got ${rec.lastLogLines.length}`);
  assert.ok(rec.lastLogLines[0].includes("truncated"));
  assert.ok(rec.lastLogLines.some((l) => l.includes("line 5999") || l.includes("done")));
});

test("runTrackedJob records a terminal timed_out (not stuck running) when the wall-clock budget is exceeded", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  // A never-resolving runner + a tiny wall-clock budget: the job must end terminal,
  // as `timed_out`, rather than be left at `running` to trap a status watcher.
  await assert.rejects(
    runTrackedJob(job, () => new Promise(() => {}), { logFile: job.logFile, wallClockMs: 50 }),
    /wall-clock budget/
  );
  const rec = readJobRecord(ws);
  assert.equal(rec.status, "timed_out");
  assert.equal(rec.phase, "timed_out");
  assert.equal(rec.pid, null);
  const fp = path.join(resolveJobsDir(ws), "t1.failure.json");
  assert.ok(fs.existsSync(fp), "a failure record should be written for the timeout");
  assert.equal(JSON.parse(fs.readFileSync(fp, "utf8")).reasonClass, "timeout");
});

test("runTrackedJob leaves the wall-clock watchdog disabled by default (no premature timeout)", async () => {
  const ws = makeTempDir();
  const job = makeJob(ws);
  // No wallClockMs option and no env -> a normal (fast) runner completes cleanly.
  await runTrackedJob(job, async () => ({ exitStatus: 0, payload: {}, rendered: "ok", summary: "ok" }), { logFile: job.logFile });
  assert.equal(readJobRecord(ws).status, "completed");
});
