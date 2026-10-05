/** Public snapshot contract: allowlists keep private export fields out of Pages. */
const configFields = [
  "id",
  "cohort_id",
  "run",
  "model",
  "agent",
  "effort",
  "label",
  "complete",
  "pilot",
  "planned",
  "scored",
  "generated",
  "score",
  "cost",
  "output_tokens",
  "agent_seconds",
  "api_seconds",
  "compile_rate",
  "cost_sources",
  "handwritten_score",
  "digital_score",
  "handwritten_perfect",
  "digital_perfect",
];
type PublicObject = Record<string, unknown>;
function object(value: unknown): asserts value is PublicObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
}
function keys(value: PublicObject, allowed: string[]) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !(key in value))
  ) {
    throw new Error("Snapshot contains unexpected or missing fields");
  }
}
function count(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error("Invalid task count");
  }
}
function measurement(value: unknown, upper = Infinity) {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > upper)
  ) {
    throw new Error("Invalid measurement");
  }
}
function text(value: unknown) {
  if (
    typeof value !== "string" || /[<>]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    value.length > 300
  ) {
    throw new Error("Invalid public label");
  }
}

export function validateSnapshot(data: unknown) {
  object(data);
  keys(data, [
    "schema_version",
    "generated_at",
    "benchmark",
    "cohorts",
    "configurations",
  ]);
  if (
    data.schema_version !== 1 || data.benchmark !== "tikz-bench" ||
    !Number.isFinite(Date.parse(String(data.generated_at)))
  ) {
    throw new Error("Unsupported public results snapshot");
  }
  if (
    !Array.isArray(data.cohorts) || !data.cohorts.length ||
    !Array.isArray(data.configurations)
  ) {
    throw new Error("Missing cohorts or configurations");
  }
  const cohorts = new Map();
  for (const cohort of data.cohorts) {
    object(cohort);
    keys(cohort, ["id", "name", "tasks", "handwritten", "digital"]);
    text(cohort.id);
    text(cohort.name);
    for (const key of ["tasks", "handwritten", "digital"]) count(cohort[key]);
    if (
      !cohort.tasks ||
      Number(cohort.handwritten) + Number(cohort.digital) !== cohort.tasks ||
      cohorts.has(cohort.id)
    ) {
      throw new Error("Invalid cohort counts or duplicate cohort");
    }
    cohorts.set(cohort.id, cohort);
  }
  const ids = new Set();
  for (const config of data.configurations) {
    object(config);
    keys(config, configFields);
    for (const key of ["id", "cohort_id", "run", "model", "agent", "label"]) {
      text(config[key]);
    }
    if (config.effort !== null) text(config.effort);
    if (
      typeof config.complete !== "boolean" ||
      typeof config.pilot !== "boolean" || ids.has(config.id)
    ) {
      throw new Error("Invalid configuration status or duplicate ID");
    }
    ids.add(config.id);
    const cohort = cohorts.get(config.cohort_id);
    if (!cohort) throw new Error("Unknown cohort");
    for (const key of ["planned", "scored", "generated"]) count(config[key]);
    if (
      Number(config.scored) > Number(config.planned) ||
      Number(config.generated) > Number(config.planned)
    ) {
      throw new Error("Progress exceeds planned tasks");
    }
    for (
      const key of [
        "score",
        "compile_rate",
        "handwritten_score",
        "digital_score",
      ]
    ) measurement(config[key], 1);
    for (
      const key of [
        "cost",
        "output_tokens",
        "agent_seconds",
        "api_seconds",
        "handwritten_perfect",
        "digital_perfect",
      ]
    ) measurement(config[key]);
    if (
      config.complete &&
      (config.pilot || config.planned !== cohort.tasks ||
        config.scored !== config.planned || config.score === null)
    ) {
      throw new Error("A partial run cannot be ranked");
    }
    if (
      !config.complete &&
      (config.score !== null ||
        config.handwritten_score !== null || config.digital_score !== null)
    ) {
      throw new Error("Incomplete results cannot publish a final score");
    }
    if (!Array.isArray(config.cost_sources)) {
      throw new Error("Invalid cost sources");
    }
    for (const source of config.cost_sources) text(source);
  }
}
