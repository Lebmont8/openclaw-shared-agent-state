import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerSharedAgentState } from "./core.js";

const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ownerTelegramId"],
  properties: {
    ownerTelegramId: { type: "string", pattern: "^[0-9]{5,20}$" },
    agentId: { type: "string", default: "main" },
    allowedAccountIds: { type: "array", items: { type: "string" }, default: ["default"] },
    accountNames: { type: "object", additionalProperties: { type: "string" } },
    timeZone: { type: "string", default: "UTC" },
  },
};

export default definePluginEntry({
  id: "shared-agent-state",
  name: "Shared Agent State",
  description: "Atomic shared memory and TaskFlow ledger for trusted Telegram entry points.",
  configSchema,
  register: registerSharedAgentState,
});
