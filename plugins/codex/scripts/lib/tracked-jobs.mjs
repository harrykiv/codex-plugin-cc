import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, resolveJobsDir, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function readLastLogLines(logFile, maxLines = 20, maxBytes = 65536) {
  if (!logFile || typeof logFile !== "string") return [];
  try {
    const st = fs.statSync(logFile);
    if (!st.isFile()) return [];
    let content;
    let truncated = false;
    if (st.size > maxBytes) {
      const fd = fs.openSync(logFile, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
        content = buf.toString("utf8", 0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
      truncated = true;
    } else {
      content = fs.readFileSync(logFile, "utf8");
    }
    let rawLines = content.split(/\r?\n/);
    if (truncated && rawLines.length > 1) rawLines = rawLines.slice(1); // drop partial leading line only if more remain
    const lines = rawLines.map((line) => line.trimEnd()).filter(Boolean).slice(-maxLines);
    if (truncated) lines.unshift("[… earlier log truncated …]");
    return lines;
  } catch {
    return [];
  }
}

// Best-effort: a write error here must never mask the original job failure.
function writeFailureRecord(job, { exitCode = null, signal = null, reasonClass, message, logFile }) {
  try {
    const failurePath = path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.failure.json`);
    const record = {
      jobId: job.id,
      status: "failed",
      exitCode,
      signal,
      reasonClass: reasonClass || "exception",
      message: message ?? "",
      lastLogLines: readLastLogLines(logFile),
      at: nowIso(),
    };
    fs.writeFileSync(failurePath, JSON.stringify(record, null, 2));
    return failurePath;
  } catch {
    return null;
  }
}

// Best-effort reason classification from the thrown error's shape/message.
function classifyFailure(error) {
  const msg = ((error && (error.message || String(error))) || "").toLowerCase();
  if ((error && error.code === "ENOENT") || /spawn|enoent|command not found/.test(msg)) return "spawn_failed";
  if (/timed out|timeout|etimedout|deadline exceeded/.test(msg)) return "timeout";
  if (/cancel/.test(msg)) return "cancelled";
  if (/\bapi\b|rate limit|\b429\b|\b5\d\d\b|stream closed|network|econnreset|fetch failed/.test(msg)) return "api_error";
  return "exception";
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  // A5: optional wall-clock watchdog. When CODEX_TASK_WALLCLOCK_MS (or
  // options.wallClockMs) is set, a task that exceeds it is recorded as a terminal
  // `timed_out` (never left stuck at `running`), so a status watcher cannot hang on
  // a job the host later hard-kills. Off by default (0) to preserve behavior; set it
  // just under any external kill ceiling (the observed Codex ceiling is ~10 min).
  const wallClockMs = Number(options.wallClockMs ?? process.env.CODEX_TASK_WALLCLOCK_MS) || 0;
  let wallClockTimer = null;
  const runWithWatchdog = () => {
    if (wallClockMs <= 0) return runner();
    return Promise.race([
      runner(),
      new Promise((_, reject) => {
        wallClockTimer = setTimeout(() => {
          const err = new Error(`task exceeded wall-clock budget of ${wallClockMs}ms`);
          err.__wallClockTimeout = true;
          reject(err);
        }, wallClockMs);
        wallClockTimer.unref?.();
      })
    ]);
  };

  try {
    const execution = await runWithWatchdog();
    if (wallClockTimer) clearTimeout(wallClockTimer);
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    try {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    } catch {
      // best-effort: a diagnostic log write must never mask the real terminal outcome
    }
    const failureFile = completionStatus === "failed"
      ? writeFailureRecord(job, {
          exitCode: execution.exitStatus,
          reasonClass: "nonzero_exit",
          message: execution.summary ?? execution.rendered ?? "non-zero exit",
          logFile: options.logFile ?? job.logFile ?? null,
        })
      : null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      failureFile,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      failureFile
    });
    return execution;
  } catch (error) {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    if (error && error.__wallClockTimeout) {
      // A5 terminal status: a wall-clock timeout is its own outcome, distinct from a
      // runner failure. Record `timed_out` (bridge `wait` maps it to TIMED_OUT) so no
      // watcher is left polling a stale `running`.
      const existingTimedOut = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      const timedOutAt = nowIso();
      const timeoutFailureFile = writeFailureRecord(job, {
        reasonClass: "timeout",
        message: error.message,
        logFile: options.logFile ?? job.logFile ?? existingTimedOut.logFile ?? null,
      });
      writeJobFile(job.workspaceRoot, job.id, {
        ...existingTimedOut,
        status: "timed_out",
        phase: "timed_out",
        errorMessage: error.message,
        failureFile: timeoutFailureFile,
        pid: null,
        completedAt: timedOutAt,
        logFile: options.logFile ?? job.logFile ?? existingTimedOut.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "timed_out",
        phase: "timed_out",
        pid: null,
        errorMessage: error.message,
        failureFile: timeoutFailureFile,
        completedAt: timedOutAt
      });
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    const canonicalFailure = path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.failure.json`);
    // If the success path already wrote a failure record for a known runner outcome,
    // preserve it — a persistence/I-O error must not reclassify the real diagnostic.
    const failureFile = fs.existsSync(canonicalFailure)
      ? canonicalFailure
      : writeFailureRecord(job, {
          reasonClass: classifyFailure(error),
          message: errorMessage,
          logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null,
        });
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      failureFile,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      failureFile,
      completedAt
    });
    throw error;
  }
}
