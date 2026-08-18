import type { JobKind } from "./constants";
import type { Policy } from "./types";

export function basePolicy(job: JobKind): Policy {
  return {
    plant: job === "planter",
    tend: job === "worker",
    harvest: job === "harvester",
    haul: job === "hauler",
    build: job === "builder",
    waitAtBarn: true,
  };
}

export function parseJobFile(md: string): Partial<Policy> {
  const t = md.toLowerCase();
  const out: Partial<Policy> = {};
  if (/till|plant|seed|sow/.test(t)) out.plant = true;
  if (/tend|work|water|weed/.test(t)) out.tend = true;
  if (/harvest|cut|ripe|wilt/.test(t)) out.harvest = true;
  if (/haul|carry|barn|clear/.test(t)) out.haul = true;
  if (/build|place|expand|plot/.test(t)) out.build = true;
  if (/wait at the barn|stand at the barn/.test(t)) out.waitAtBarn = true;
  return out;
}

export function jobPolicy(job: JobKind, md: string): Policy {
  return { ...basePolicy(job), ...parseJobFile(md) };
}

export function mergePolicy(base: Policy, patch: Partial<Policy>): Policy {
  return { ...base, ...patch };
}

export function policyFromUnknown(raw: unknown, fallback: Policy): Policy {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const b = (k: string, d: boolean) => (typeof o[k] === "boolean" ? (o[k] as boolean) : d);
  return {
    plant: b("plant", fallback.plant),
    tend: b("tend", fallback.tend),
    harvest: b("harvest", fallback.harvest),
    haul: b("haul", fallback.haul),
    build: b("build", fallback.build),
    waitAtBarn: b("waitAtBarn", fallback.waitAtBarn),
  };
}
