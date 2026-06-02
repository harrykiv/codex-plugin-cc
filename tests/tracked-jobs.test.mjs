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
