import tokenSamples from "../data/subscription-tokens.json";
import type { Category, Configuration } from "./model";

// Monthly API-equivalent allowances audited on the author's Uses page:
// https://plei99.github.io/en/uses.html#ai-subscriptions
// Codex includes the October 29 doubling; K3.1 was measured November 2.
const allowances = [
  {
    agent: "codex",
    models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
    monthlyUsd: 100,
    apiUsd: 2833.2194350755494,
  },
  {
    agent: "claude",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    monthlyUsd: 100,
    apiUsd: 4605.338690476191,
  },
  {
    agent: "antigravity",
    models: ["gemini-4-argon"],
    monthlyUsd: 100,
    apiUsd: 426.05901063035714,
  },
  {
    agent: "kimi",
    models: ["k3.1-pro"],
    monthlyUsd: 100,
    apiUsd: 343.1819512670564,
  },
  {
    agent: "kimi",
    models: ["k3"],
    monthlyUsd: 100,
    apiUsd: 482.53775950668035,
  },
];
const samples = new Map(tokenSamples.map((sample) => [sample.id, sample]));

/** The monthly fee allocated to one task when the full allowance is used. */
export function subscriptionCost(
  config: Configuration,
  category: Category = "overall",
): number | null {
  const part = category === "taste" ? "handwritten" : category;
  if (["glm-5.3-flash", "mimo-v2.6-pro"].includes(config.model)) {
    const sample = samples.get(config.id);
    // A refreshed generation needs matching token evidence. Rejudging the same
    // answer can change its score without changing this calibration.
    if (
      !sample || sample.model !== config.model ||
      sample.agent !== config.agent ||
      sample.cohort_id !== config.cohort_id ||
      sample.planned !== config.planned ||
      sample.cost !== config.cost ||
      sample.output_tokens !== config.output_tokens
    ) return null;
    const t = sample[part];
    if (!t.tasks) return null;
    if (config.model === "mimo-v2.6-pro") {
      // https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription
      // Max: $100 / 82B credits, regular hours. Output includes reasoning.
      return 100 * (t.uncached * 300 + t.cached * 2.5 + t.output * 600) /
        t.tasks / 82e9;
    }
    // https://docs.z.ai/devpack/overview
    // Pro: $80 / 60K credits weekly. Half peak, half off-peak costs 0.75x.
    const credits = (t.uncached * 2.3 + t.cached * 0.56 + t.output * 8) /
      10000 * 0.75;
    return 80 * credits / t.tasks / (60000 * 365.25 / 12 / 7);
  }
  const allowance = allowances.find((a) =>
    a.agent === config.agent && a.models.includes(config.model)
  );
  const cost = part === "overall" ? config.cost : config[`${part}_cost`];
  return allowance && cost !== null
    ? allowance.monthlyUsd * cost / allowance.apiUsd
    : null;
}
