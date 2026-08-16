import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
const PLUGIN_ID = "shared-agent-state";
const SHARED_TASK_OWNER = "agent:main:shared-agent-state-ledger";
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 120_000;
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "waiting", "blocked"]);
const MEMORY_TYPES = new Set(["fact", "decision", "preference", "status", "lesson"]);
const MEMORY_CONFIDENCE = new Set(["confirmed", "high"]);
const TELEGRAM_DIRECT_RE =
  /^agent:(?<agent>[^:]+):telegram:(?:(?<account>[^:]+):)?direct:(?<peer>[^:]+)$/;

const MEMORY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["text", "type", "confidence"],
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "Confirmed fact, decision, preference, status, or lesson to remember.",
    },
    type: {
      type: "string",
      enum: [...MEMORY_TYPES],
    },
    confidence: {
      type: "string",
      enum: [...MEMORY_CONFIDENCE],
    },
    scope: {
      type: "string",
      enum: ["daily", "long_term"],
      default: "daily",
    },
    supersedes: {
      type: "string",
      pattern: "^mem_[a-zA-Z0-9_-]{8,80}$",
      description: "Existing shared-memory id corrected by this record.",
    },
  },
};

const TASK_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["list", "start", "update", "block", "complete", "fail"],
    },
    taskId: {
      type: "string",
      description: "TaskFlow id or unique id prefix for update/block/complete/fail.",
    },
    goal: {
      type: "string",
      minLength: 1,
      maxLength: 500,
    },
    currentStep: {
      type: "string",
      maxLength: 500,
    },
    project: {
      type: "string",
      maxLength: 200,
      description: "Stable project or resource name shown in the shared ledger.",
    },
    lockKey: {
      type: "string",
      pattern: "^[a-zA-Z0-9._:/-]{1,200}$",
      description: "Exclusive write-lock key, normally the project or repository path.",
    },
    reason: {
      type: "string",
      maxLength: 500,
    },
    includeTerminal: {
      type: "boolean",
      default: false,
    },
  },
};

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function parseTelegramDirectSession(sessionKey) {
  const match = TELEGRAM_DIRECT_RE.exec(String(sessionKey || ""));
  if (!match?.groups?.peer) return null;
  return {
    agentId: match.groups.agent,
    accountId: match.groups.account || "default",
    peerId: match.groups.peer,
  };
}

export function resolveSourceIdentity(ctx, accountNames = {}) {
  const parsed = parseTelegramDirectSession(ctx?.sessionKey);
  if (!parsed) return null;
  const accountId = String(ctx?.deliveryContext?.accountId || parsed.accountId || "default");
  return {
    agentId: parsed.agentId,
    accountId,
    botName: String(accountNames[accountId] || accountId),
    peerId: String(ctx?.requesterSenderId || parsed.peerId),
    sourceChat: `telegram:${accountId}:${String(ctx?.requesterSenderId || parsed.peerId)}`,
    sessionKey: String(ctx.sessionKey),
  };
}

export function assertOwnerContext(ctx, config) {
  const agentId = String(config?.agentId || "main");
  const ownerTelegramId = String(config?.ownerTelegramId || "");
  const allowedAccountIds = new Set(
    Array.isArray(config?.allowedAccountIds) && config.allowedAccountIds.length > 0
      ? config.allowedAccountIds.map(String)
      : ["default"],
  );
  if (ctx?.agentId !== agentId) {
    throw new Error(`Shared state is available only to agent ${agentId}.`);
  }
  const source = resolveSourceIdentity(ctx, config?.accountNames || {});
  if (source?.agentId !== agentId) {
    throw new Error("The session key does not match the configured agent.");
  }
  if (!source || source.peerId !== ownerTelegramId) {
    throw new Error("Shared state is available only in the owner's Telegram direct chats.");
  }
  if (!allowedAccountIds.has(source.accountId)) {
    throw new Error("This Telegram account is not an approved entry point.");
  }
  return source;
}

export function containsSecretLikeText(value) {
  const text = String(value || "");
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bsk-[a-z0-9_-]{20,}\b/i,
    /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*\b/i,
  ].some((pattern) => pattern.test(text));
}

function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return parts;
}

export function formatTimestamp(date = new Date(), timeZone = "UTC") {
  const parts = zonedParts(date, timeZone);
  const secondPrecision = Math.floor(date.getTime() / 1000) * 1000;
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((wallClockAsUtc - secondPrecision) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function dateKeyFromTimestamp(timestamp) {
  return timestamp.slice(0, 10);
}

function makeMemoryId(timestamp, uuid = randomUUID()) {
  return `mem_${timestamp.slice(0, 10).replaceAll("-", "")}_${Date.now().toString(36)}_${uuid.replaceAll("-", "").slice(0, 10)}`;
}

function indentText(text) {
  return String(text)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function buildMemoryBlock(record) {
  return [
    `<!-- shared-agent-memory:start id=${record.id} -->`,
    `## Shared memory: \`${record.id}\``,
    `- id: \`${record.id}\``,
    `- author_agent: \`${record.authorAgent}\``,
    `- source_bot: \`${record.sourceBot}\``,
    `- source_account: \`${record.sourceAccount}\``,
    `- source_chat: \`${record.sourceChat}\``,
    `- timestamp: \`${record.timestamp}\``,
    `- type: \`${record.type}\``,
    `- confidence: \`${record.confidence}\``,
    `- supersedes: ${record.supersedes ? `\`${record.supersedes}\`` : "`null`"}`,
    "- text:",
    indentText(record.text),
    `<!-- shared-agent-memory:end id=${record.id} -->`,
  ].join("\n");
}

function buildSupersededBlock(oldId, newId) {
  return [
    `<!-- shared-agent-memory:start id=${oldId} -->`,
    `## Shared memory: \`${oldId}\` (superseded)`,
    `- id: \`${oldId}\``,
    `- superseded_by: \`${newId}\``,
    "- text:",
    `  Superseded by \`${newId}\`; the original is retained only in the private audit journal.`,
    `<!-- shared-agent-memory:end id=${oldId} -->`,
  ].join("\n");
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function acquireLock(lockDir) {
  await mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      return async () => {
        try {
          await rmdir(lockDir);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rmdir(lockDir);
          continue;
        }
      } catch (statError) {
        if (!["ENOENT", "ENOTEMPTY"].includes(statError?.code)) throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
    }
  }
  throw new Error("Timed out waiting for the shared-memory lock.");
}

async function findMemoryRecord(workspaceDir, id) {
  const candidates = [path.join(workspaceDir, "MEMORY.md")];
  const memoryDir = path.join(workspaceDir, "memory");
  try {
    const names = await readdir(memoryDir);
    for (const name of names) {
      if (name.endsWith(".md")) candidates.push(path.join(memoryDir, name));
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<!-- shared-agent-memory:start id=${escaped} -->[\\s\\S]*?<!-- shared-agent-memory:end id=${escaped} -->`,
  );
  for (const filePath of candidates) {
    const content = await readOptional(filePath);
    const match = pattern.exec(content);
    if (match) return { filePath, content, block: match[0], pattern };
  }
  return null;
}

export async function rememberSharedMemory({
  workspaceDir,
  source,
  input,
  now = new Date(),
  uuid = randomUUID(),
  timeZone = "UTC",
}) {
  const text = String(input?.text || "").trim();
  const type = String(input?.type || "");
  const confidence = String(input?.confidence || "");
  const requestedScope = input?.scope === "long_term" ? "long_term" : "daily";
  const supersedes = input?.supersedes ? String(input.supersedes) : null;
  if (!text || text.length > 4000) throw new Error("Memory text must contain 1-4000 characters.");
  if (containsSecretLikeText(text)) throw new Error("Secret-like content cannot be stored in shared memory.");
  if (!MEMORY_TYPES.has(type)) throw new Error("Unsupported memory type.");
  if (!MEMORY_CONFIDENCE.has(confidence)) throw new Error("Unconfirmed hypotheses cannot be stored in shared memory.");
  if (supersedes && !/^mem_[a-zA-Z0-9_-]{8,80}$/.test(supersedes)) {
    throw new Error("Invalid supersedes id.");
  }
  const timestamp = formatTimestamp(now, timeZone);
  const id = makeMemoryId(timestamp, uuid);
  if (supersedes === id) throw new Error("A memory record cannot supersede itself.");
  const record = {
    id,
    authorAgent: "main",
    sourceBot: source.botName,
    sourceAccount: source.accountId,
    sourceChat: source.sourceChat,
    sourceSessionKey: source.sessionKey,
    timestamp,
    type,
    confidence,
    supersedes,
    text,
  };
  const stateDir = path.join(workspaceDir, ".shared-agent-state");
  const release = await acquireLock(path.join(stateDir, "memory.lock"));
  try {
    let prior = null;
    if (supersedes) {
      prior = await findMemoryRecord(workspaceDir, supersedes);
      if (!prior) throw new Error(`Memory record not found: ${supersedes}`);
    }
    const longTermPath = path.join(workspaceDir, "MEMORY.md");
    const destination = prior
      ? prior.filePath
      : requestedScope === "long_term"
        ? longTermPath
        : path.join(workspaceDir, "memory", `${dateKeyFromTimestamp(timestamp)}.md`);
    const scope = destination === longTermPath ? "long_term" : "daily";
    let current = prior
      ? prior.content.replace(
          prior.pattern,
          buildSupersededBlock(supersedes, id),
        )
      : await readOptional(destination);
    if (!current.trim()) {
      current = scope === "long_term" ? "# MEMORY.md\n" : `# ${dateKeyFromTimestamp(timestamp)}\n`;
    }
    const next = `${current.trimEnd()}\n\n${buildMemoryBlock(record)}\n`;
    await atomicWrite(destination, next);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const auditPath = path.join(stateDir, "memory-audit.jsonl");
    await appendFile(
      auditPath,
      `${JSON.stringify({
        operation: supersedes ? "supersede" : "create",
        record,
        priorBlock: prior?.block || null,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { id, destination, scope, timestamp, supersedes };
  } finally {
    await release();
  }
}

function taskState(flow) {
  return flow?.stateJson && typeof flow.stateJson === "object" && !Array.isArray(flow.stateJson)
    ? flow.stateJson
    : {};
}

export function findTaskLockConflict(flows, lockKey) {
  if (!lockKey) return null;
  return (
    flows.find((flow) => {
      const state = taskState(flow);
      return ACTIVE_TASK_STATUSES.has(flow.status) && state.lockKey === lockKey;
    }) || null
  );
}

function viewTask(flow) {
  const state = taskState(flow);
  return {
    id: flow.flowId,
    status: flow.status,
    goal: flow.goal,
    currentStep: flow.currentStep || null,
    project: state.project || null,
    lockKey: state.lockKey || null,
    ownerBot: state.ownerBot || null,
    ownerSessionKey: state.ownerSessionKey || null,
    updatedByBot: state.updatedByBot || null,
    revision: flow.revision,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    endedAt: flow.endedAt || null,
  };
}

function resolveFlow(runtime, token) {
  if (!token) return null;
  return runtime.resolve(String(token)) || runtime.get(String(token)) || null;
}

function mutateWithLatest(runtime, token, source, mutation) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const flow = resolveFlow(runtime, token);
    if (!flow) return { error: "task_not_found" };
    const nextState = {
      ...taskState(flow),
      updatedByBot: source.accountId,
      updatedBySessionKey: source.sessionKey,
      updatedAt: Date.now(),
    };
    const result = mutation(flow, nextState);
    if (result.applied) return { flow: result.flow };
    if (result.code !== "revision_conflict") return { error: result.code };
  }
  return { error: "revision_conflict" };
}

export function createTaskLedgerTool({ api, ctx, source }) {
  const runtime = api.runtime.tasks.managedFlows.bindSession({
    sessionKey: SHARED_TASK_OWNER,
  });
  return {
    name: "shared_task_ledger",
    description:
      "Read or update a shared TaskFlow ledger. Start tasks with a lockKey before writing a project; list it before related work; complete or fail entries when done.",
    parameters: TASK_PARAMETERS,
    async execute(_toolCallId, input) {
      const action = String(input?.action || "");
      if (action === "list") {
        const includeTerminal = input?.includeTerminal === true;
        const tasks = runtime
          .list()
          .filter((flow) => includeTerminal || ACTIVE_TASK_STATUSES.has(flow.status))
          .map(viewTask);
        return textResult({ tasks });
      }
      if (action === "start") {
        const goal = String(input?.goal || "").trim();
        const project = String(input?.project || "").trim() || null;
        const lockKey = String(input?.lockKey || "").trim() || null;
        if (!goal) return textResult({ error: "goal_required" }, true);
        const conflict = findTaskLockConflict(runtime.list(), lockKey);
        if (conflict) {
          return textResult({ error: "write_lock_conflict", conflict: viewTask(conflict) }, true);
        }
        const created = runtime.createManaged({
          controllerId: `${PLUGIN_ID}/shared-ledger`,
          goal,
          status: "running",
          currentStep: String(input?.currentStep || "").trim() || "started",
          stateJson: {
            project,
            lockKey,
            ownerBot: source.accountId,
            ownerSessionKey: source.sessionKey,
            ownerChat: source.sourceChat,
            updatedByBot: source.accountId,
            updatedBySessionKey: source.sessionKey,
            updatedAt: Date.now(),
          },
        });
        return textResult({ task: viewTask(created) });
      }
      if (!["update", "block", "complete", "fail"].includes(action)) {
        return textResult({ error: "unsupported_action" }, true);
      }
      const taskId = String(input?.taskId || "").trim();
      if (!taskId) return textResult({ error: "task_id_required" }, true);
      let outcome;
      if (action === "update") {
        outcome = mutateWithLatest(runtime, taskId, source, (flow, stateJson) =>
          runtime.resume({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            status: "running",
            currentStep: String(input?.currentStep || "").trim() || flow.currentStep || "running",
            stateJson,
          }),
        );
      } else if (action === "block") {
        const reason = String(input?.reason || "").trim() || "waiting for input or external state";
        outcome = mutateWithLatest(runtime, taskId, source, (flow, stateJson) =>
          runtime.setWaiting({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            currentStep: String(input?.currentStep || "").trim() || flow.currentStep || "waiting",
            stateJson,
            waitJson: { kind: "shared-ledger", reason },
            blockedSummary: reason,
          }),
        );
      } else if (action === "complete") {
        outcome = mutateWithLatest(runtime, taskId, source, (flow, stateJson) =>
          runtime.finish({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            stateJson: {
              ...stateJson,
              terminalReason: String(input?.reason || "").trim() || null,
            },
          }),
        );
      } else {
        outcome = mutateWithLatest(runtime, taskId, source, (flow, stateJson) =>
          runtime.fail({
            flowId: flow.flowId,
            expectedRevision: flow.revision,
            stateJson: {
              ...stateJson,
              terminalReason: String(input?.reason || "").trim() || "failed",
            },
            blockedSummary: String(input?.reason || "").trim() || "failed",
          }),
        );
      }
      if (outcome.error) return textResult({ error: outcome.error }, true);
      return textResult({ task: viewTask(outcome.flow) });
    },
  };
}

export function registerSharedAgentState(api) {
    const config = {
      ownerTelegramId: String(api.pluginConfig?.ownerTelegramId || ""),
      agentId: String(api.pluginConfig?.agentId || "main"),
      allowedAccountIds: api.pluginConfig?.allowedAccountIds || ["default"],
      accountNames: api.pluginConfig?.accountNames || {},
      timeZone: String(api.pluginConfig?.timeZone || "UTC"),
    };
    api.registerTool(
      (ctx) => {
        let source;
        try {
          source = assertOwnerContext(ctx, config);
        } catch {
          return null;
        }
        return {
          name: "shared_memory_remember",
          description:
            "Atomically store a confirmed shared memory with provenance. Use supersedes to correct an earlier shared record; never store secrets, raw logs, documents, or hypotheses.",
          parameters: MEMORY_PARAMETERS,
          async execute(_toolCallId, input) {
            try {
              const result = await rememberSharedMemory({
                workspaceDir: ctx.workspaceDir,
                source,
                input,
                timeZone: config.timeZone,
              });
              return textResult({ stored: true, ...result });
            } catch (error) {
              return textResult({ stored: false, error: error?.message || String(error) }, true);
            }
          },
        };
      },
      { names: ["shared_memory_remember"] },
    );
    api.registerTool(
      (ctx) => {
        let source;
        try {
          source = assertOwnerContext(ctx, config);
        } catch {
          return null;
        }
        return createTaskLedgerTool({ api, ctx, source });
      },
      { names: ["shared_task_ledger"] },
    );
}
