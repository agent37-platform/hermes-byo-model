export interface Shape {
  label: string;
  cpu: number;
  memory: number;
  diskMin: number;
  diskMax: number;
}

// Workspace (custom) templates take the standard shapes; the 1 vCPU small shape is reserved for
// Agent37's own lean system template, so it is not offered here.
export const SHAPE_PRESETS: Shape[] = [
  { label: "Standard · 2 vCPU / 4 GB", cpu: 2, memory: 4, diskMin: 6, diskMax: 20 },
  { label: "Pro · 4 vCPU / 8 GB", cpu: 4, memory: 8, diskMin: 20, diskMax: 40 },
  { label: "Max · 8 vCPU / 16 GB", cpu: 8, memory: 16, diskMin: 40, diskMax: 80 },
];

// The workspace template this kit publishes with `npm run templates:publish` (see
// scripts/templates.mjs — the name there must match). It's Agent37's CLEAN Hermes base image, which
// boots with NO model provider, so the config this app writes (src/lib/bootstrap.ts) — your
// OpenRouter proxy — is the only one the agent has. Rename freely, but publish before creating
// agents.
export const TEMPLATE_NAME = "hermes-byo-model";

export const DEFAULT_AGENT = {
  template: TEMPLATE_NAME,
  cpu: 2,
  memory: 4,
  disk: 6,
} as const;

export interface AgentTypeOption {
  id: string;
  template: string;
  label: string;
  description: string;
  recommended?: boolean;
}

// The agent types offered on the create screen. One entry here — every agent runs Hermes on your
// OpenRouter key. Add a second image (see the custom-agent-image repo) by publishing another
// template and listing it here.
export const AGENT_TYPES: AgentTypeOption[] = [
  {
    id: "hermes",
    template: TEMPLATE_NAME,
    label: "Hermes",
    description: "General agent: chat, browsing, code, files — on your own model.",
    recommended: true,
  },
];

export const AGENT_TEMPLATES = AGENT_TYPES.map((a) => a.template);

// Web-service ports the base image runs. The live API reports `ports: []` for instances on
// workspace templates (only system templates carry a service-port list), so the fleet GET
// synthesizes these for the open-in-new-tab buttons; signed URLs work for any listening port.
export const SERVICE_PORTS = [9119, 7681, 8080];

// Labels for the "open in new tab" buttons. This only prettifies known port numbers; any
// unrecognized port falls back to "Port {n}".
export const PORT_LABELS: Record<number, string> = {
  9119: "Dashboard",
  7681: "Terminal",
  8080: "Files",
};
