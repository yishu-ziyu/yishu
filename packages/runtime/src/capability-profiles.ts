import type { CapabilityProfile } from "./protocol.js";

export interface PiCapabilityConfiguration {
  tools?: string[];
  noTools?: "all" | "builtin";
}

export const PI_CAPABILITY_PROFILES: Record<CapabilityProfile, PiCapabilityConfiguration> = {
  conversation: {
    noTools: "builtin",
  },
  observe: {
    tools: ["read", "grep", "find", "ls"],
  },
  build: {
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  },
  owner: {},
};

