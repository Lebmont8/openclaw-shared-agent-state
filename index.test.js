import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertOwnerContext,
  containsSecretLikeText,
  createTaskLedgerTool,
  findTaskLockConflict,
  formatTimestamp,
  parseTelegramDirectSession,
  rememberSharedMemory,
  resolveSourceIdentity,
} from "./core.js";

const SOURCE_X = {
  agentId: "main",
  accountId: "assistant_x",
  botName: "Assistant X",
  peerId: "123456789",
  sourceChat: "telegram:assistant_x:123456789",
  sessionKey: "agent:main:telegram:assistant_x:direct:123456789",
};

const SOURCE_Y = {
  agentId: "main",
  accountId: "assistant_y",
  botName: "Assistant Y",
  peerId: "123456789",
  sourceChat: "telegram:assistant_y:123456789",
  sessionKey: "agent:main:telegram:assistant_y:direct:123456789",
};

function createFakeTaskRuntime() {
  const flows = [];
  let sequence = 0;
  const resolve = (token) =>
    flows.find((flow) => flow.flowId === token) ||
    flows.find((flow) => flow.flowId.startsWith(token));
  const mutate = (input, patch) => {
    const flow = resolve(input.flowId);
    if (!flow) return { applied: false, code: "not_found" };
    if (flow.revision !== input.expectedRevision) {
      return { applied: false, code: "revision_conflict", current: flow };
    }
    Object.assign(flow, patch(flow));
    flow.revision += 1;
    flow.updatedAt += 1;
    return { applied: true, flow };
  };
  return {
    flows,
    list: () => flows,
    get: resolve,
    resolve,
    createManaged(input) {
      const now = Date.now() + sequence;
      const flow = {
        flowId: `flow-${++sequence}`,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      flows.push(flow);
      return flow;
    },
    resume: (input) =>
      mutate(input, () => ({
        status: input.status || "running",
        currentStep: input.currentStep,
        stateJson: input.stateJson,
      })),
    setWaiting: (input) =>
      mutate(input, () => ({
        status: "waiting",
        currentStep: input.currentStep,
        stateJson: input.stateJson,
        waitJson: input.waitJson,
        blockedSummary: input.blockedSummary,
      })),
    finish: (input) =>
      mutate(input, () => ({
        status: "succeeded",
        stateJson: input.stateJson,
        endedAt: Date.now(),
      })),
    fail: (input) =>
      mutate(input, () => ({
        status: "failed",
        stateJson: input.stateJson,
        blockedSummary: input.blockedSummary,
        endedAt: Date.now(),
      })),
  };
}

test("parses default and account-scoped direct sessions", () => {
  assert.deepEqual(
    parseTelegramDirectSession("agent:main:telegram:direct:123456789"),
    { agentId: "main", accountId: "default", peerId: "123456789" },
  );
  assert.deepEqual(
    parseTelegramDirectSession("agent:main:telegram:assistant_x:direct:123456789"),
    { agentId: "main", accountId: "assistant_x", peerId: "123456789" },
  );
  assert.equal(parseTelegramDirectSession("not-a-session"), null);
});

test("resolves stable source provenance from trusted tool context", () => {
  assert.deepEqual(
    resolveSourceIdentity({
      sessionKey: SOURCE_X.sessionKey,
      requesterSenderId: "123456789",
      deliveryContext: { accountId: "assistant_x" },
    }, { assistant_x: "Assistant X" }),
    SOURCE_X,
  );
});

test("fails closed outside the owner's approved direct chats", () => {
  const config = {
    ownerTelegramId: "123456789",
    agentId: "main",
    allowedAccountIds: ["default", "assistant_x", "assistant_y"],
    accountNames: { assistant_x: "Assistant X", assistant_y: "Assistant Y" },
  };
  assert.throws(
    () =>
      assertOwnerContext(
        {
          agentId: "eva",
          sessionKey: "agent:eva:telegram:direct:123456789",
        },
        config,
      ),
    /only to agent main/,
  );
  assert.throws(
    () =>
      assertOwnerContext(
        {
          agentId: "main",
          sessionKey: "agent:main:telegram:assistant_x:direct:999999999",
        },
        config,
      ),
    /owner's Telegram direct chats/,
  );
  assert.throws(
    () =>
      assertOwnerContext(
        {
          agentId: "main",
          sessionKey: "agent:main:telegram:other:direct:123456789",
        },
        config,
      ),
    /not an approved entry point/,
  );
});

test("formats a configured timezone timestamp with DST offset", () => {
  assert.equal(
    formatTimestamp(new Date("2026-07-22T01:39:34Z"), "Europe/Berlin"),
    "2026-07-22T03:39:34+02:00",
  );
});

test("rejects obvious secret shapes", () => {
  assert.equal(containsSecretLikeText("normal confirmed preference"), false);
  assert.equal(containsSecretLikeText("123456789:abcdefghijklmnopqrstuvwxyzABCDE12345"), true);
  assert.equal(containsSecretLikeText("Bearer abcdefghijklmnopqrstuvwxyz123456"), true);
});

test("serializes concurrent memory writes without losing records", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "shared-memory-"));
  const writes = Array.from({ length: 12 }, (_, index) =>
    rememberSharedMemory({
      workspaceDir,
      source: SOURCE_X,
      input: {
        text: `confirmed record ${index}`,
        type: "fact",
        confidence: "confirmed",
      },
      now: new Date("2026-07-22T01:39:34Z"),
      timeZone: "Europe/Berlin",
      uuid: `${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
    }),
  );
  const results = await Promise.all(writes);
  const daily = await readFile(path.join(workspaceDir, "memory", "2026-07-22.md"), "utf8");
  for (const [index, result] of results.entries()) {
    assert.match(daily, new RegExp(result.id));
    assert.match(daily, new RegExp(`confirmed record ${index}`));
  }
});

test("superseding removes stale text from indexed memory and retains audit", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "shared-memory-fix-"));
  const original = await rememberSharedMemory({
    workspaceDir,
    source: SOURCE_X,
    input: { text: "wrong old fact", type: "fact", confidence: "confirmed" },
    now: new Date("2026-07-22T01:39:34Z"),
    timeZone: "Europe/Berlin",
    uuid: "11111111-1111-1111-1111-111111111111",
  });
  const correction = await rememberSharedMemory({
    workspaceDir,
    source: SOURCE_X,
    input: {
      text: "correct new fact",
      type: "fact",
      confidence: "confirmed",
      supersedes: original.id,
    },
    now: new Date("2026-07-22T01:40:34Z"),
    timeZone: "Europe/Berlin",
    uuid: "22222222-2222-2222-2222-222222222222",
  });
  const daily = await readFile(path.join(workspaceDir, "memory", "2026-07-22.md"), "utf8");
  const audit = await readFile(
    path.join(workspaceDir, ".shared-agent-state", "memory-audit.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(daily, /wrong old fact/);
  assert.ok(daily.includes(`superseded_by: \`${correction.id}\``));
  assert.match(daily, /correct new fact/);
  assert.match(audit, /wrong old fact/);
});

test("detects only active tasks with the same write lock", () => {
  const flows = [
    { flowId: "active", status: "running", stateJson: { lockKey: "crm" } },
    { flowId: "done", status: "succeeded", stateJson: { lockKey: "crm" } },
  ];
  assert.equal(findTaskLockConflict(flows, "crm")?.flowId, "active");
  assert.equal(findTaskLockConflict(flows, "other"), null);
  assert.equal(findTaskLockConflict(flows, null), null);
});

test("shares one TaskFlow ledger and releases a project lock on completion", async () => {
  const runtime = createFakeTaskRuntime();
  const boundOwners = [];
  const api = {
    runtime: {
      tasks: {
        managedFlows: {
          bindSession({ sessionKey }) {
            boundOwners.push(sessionKey);
            return runtime;
          },
        },
      },
    },
  };
  const toolX = createTaskLedgerTool({ api, ctx: {}, source: SOURCE_X });
  const toolY = createTaskLedgerTool({ api, ctx: {}, source: SOURCE_Y });
  const first = await toolX.execute("1", {
    action: "start",
    goal: "Change CRM monitor",
    project: "content-agency-crm",
    lockKey: "content-agency-crm",
  });
  assert.equal(first.details.task.ownerBot, "assistant_x");
  const conflict = await toolY.execute("2", {
    action: "start",
    goal: "Change the same CRM files",
    project: "content-agency-crm",
    lockKey: "content-agency-crm",
  });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.details.error, "write_lock_conflict");
  const completed = await toolY.execute("3", {
    action: "complete",
    taskId: first.details.task.id,
    reason: "done",
  });
  assert.equal(completed.details.task.status, "succeeded");
  const next = await toolY.execute("4", {
    action: "start",
    goal: "New CRM change",
    project: "content-agency-crm",
    lockKey: "content-agency-crm",
  });
  assert.equal(next.details.task.ownerBot, "assistant_y");
  assert.deepEqual([...new Set(boundOwners)], ["agent:main:shared-agent-state-ledger"]);
});
