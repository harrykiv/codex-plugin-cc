import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { enrichJob } from "../plugins/codex/scripts/lib/job-control.mjs";

test("enrichJob derives lastEventAt from logFile mtime (mtime wins over stale updatedAt)", () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "job.log");
  fs.writeFileSync(logFile, "[2026-06-02] line\n");
  const job = {
    id: "j1", status: "running", logFile,
    createdAt: "2026-06-02T00:00:00.000Z", startedAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
  const enriched = enrichJob(job);
  const mtimeIso = new Date(fs.statSync(logFile).mtimeMs).toISOString();
  assert.equal(enriched.lastEventAt, mtimeIso);
  assert.equal(typeof enriched.secondsSinceLastEvent, "number");
  assert.ok(enriched.secondsSinceLastEvent >= 0 && enriched.secondsSinceLastEvent < 5);
});

test("enrichJob falls back to updatedAt when logFile is absent", () => {
  const job = {
    id: "j2", status: "completed", logFile: null,
    createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
  };
  const enriched = enrichJob(job);
  assert.equal(enriched.lastEventAt, "2026-06-02T00:00:00.000Z");
  assert.equal(typeof enriched.secondsSinceLastEvent, "number");
});

test("enrichJob yields null freshness when neither logFile nor updatedAt exists", () => {
  const job = { id: "j3", status: "completed", logFile: null, createdAt: "2026-06-02T00:00:00.000Z" };
  const enriched = enrichJob(job);
  assert.equal(enriched.lastEventAt, null);
  assert.equal(enriched.secondsSinceLastEvent, null);
});

test("enrichJob does not throw when logFile is present but unreadable (e.g. a directory)", () => {
  const dir = makeTempDir();
  const job = {
    id: "j4", status: "running", logFile: dir, // a directory: exists but not a readable file (readFileSync throws EISDIR)
    createdAt: "2026-06-02T00:00:00.000Z", updatedAt: "2026-06-02T00:00:00.000Z",
  };
  const enriched = enrichJob(job); // must NOT throw
  assert.ok(Array.isArray(enriched.progressPreview));
  assert.equal(enriched.progressPreview.length, 0);
  assert.ok(enriched.lastEventAt === null || typeof enriched.lastEventAt === "string");
});
