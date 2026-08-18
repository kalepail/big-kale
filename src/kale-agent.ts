import { Agent } from "agents";
import {
  CREDIT_FEE,
  KALE_PER_USD,
  LLM_MIN_KALE,
  LUNA_IN_PER_M,
  LUNA_OUT_PER_M,
} from "./sim/constants";
import { policyFromUnknown } from "./sim/policy";
import type { Policy, ThinkResult, ThinkView } from "./sim/types";

type AgentState = {
  jobFile: string;
  lastNote: string;
};

const SYSTEM = `You compile a farm job file into a tiny JSON policy.
Return ONLY JSON: {"plant":bool,"tend":bool,"harvest":bool,"haul":bool,"build":bool,"waitAtBarn":bool,"note":string}
note <= 80 chars, slightly unserious. No markdown.`;

export class KaleAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { jobFile: "", lastNote: "" };

  async think(view: ThinkView, current: Policy, kale: number): Promise<ThinkResult> {
    if (kale < LLM_MIN_KALE) {
      return {
        policy: current,
        note: "too broke to think",
        usage: { input: 0, output: 0 },
        model: "none",
        skipped: true,
        kaleCost: 0,
      };
    }

    const prompt = `${SYSTEM}

Job: ${view.job}
File:
${view.jobFile}

Idle ${view.idleSeconds.toFixed(0)}s doing ${view.action}.
Farm KALE=${view.kale.toFixed(1)} ripe=${view.ripeCount} wilt=${view.wiltCount} ground=${view.groundCount}
Nearby: ${view.nearby
      .slice(0, 12)
      .map((n) => `${n.state}@${n.x},${n.y}${n.designation ? "/" + n.designation : ""}${n.groundKale ? " kale" : ""}`)
      .join("; ")}`;

    const run = async () => {
      try {
        const resp = await this.env.AI.run(
          "openai/gpt-5.6-luna",
          {
            input: prompt,
            max_output_tokens: 96,
            reasoning: { effort: "none" },
          },
          {
            gateway: {
              id: "default",
              skipCache: true,
              metadata: {
                world_id: "kale-1",
                agent_id: this.name,
                kind: "policy",
              },
            },
          },
        );
        return { resp, model: "openai/gpt-5.6-luna" };
      } catch (err) {
        const resp = await this.env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          { prompt },
          {
            gateway: {
              id: "default",
              skipCache: true,
              metadata: {
                world_id: "kale-1",
                agent_id: this.name,
                kind: "policy-fallback",
              },
            },
          },
        );
        return { resp, model: "@cf/meta/llama-3.1-8b-instruct-fast" };
      }
    };

    const { resp, model } = await this.keepAliveWhile(run);

    const text = extractText(resp);
    const usage = extractUsage(resp);
    const kaleCost = tokenToKale(usage.input, usage.output);
    const parsed = parsePolicyJson(text);
    const policy = policyFromUnknown(parsed ?? {}, current);
    const note =
      (parsed && typeof parsed.note === "string" && parsed.note.slice(0, 80)) ||
      text.slice(0, 80) ||
      "compiled the file. still a pail.";
    this.setState({ jobFile: view.jobFile, lastNote: note });
    return { policy, note, usage, model, skipped: false, kaleCost };
  }
}

function tokenToKale(input: number, output: number): number {
  const usd = (input * LUNA_IN_PER_M + output * LUNA_OUT_PER_M) / 1e6;
  const loaded = usd * CREDIT_FEE;
  return Math.max(0.1, Math.ceil(loaded * KALE_PER_USD * 10) / 10);
}

function extractText(resp: any): string {
  if (!resp) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp.output_text === "string") return resp.output_text;
  if (typeof resp.response === "string") return resp.response;
  if (typeof resp.result === "string") return resp.result;
  const out = resp.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") return c.text;
        }
      }
      if (typeof item?.text === "string") return item.text;
    }
  }
  if (resp.choices?.[0]?.message?.content) return String(resp.choices[0].message.content);
  return JSON.stringify(resp).slice(0, 400);
}

function extractUsage(resp: any): { input: number; output: number } {
  const u = resp?.usage ?? {};
  return {
    input: Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0,
    output: Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0,
  };
}

function parsePolicyJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
