// Scripts inlined into the page head, written in TypeScript under
// client/inline/ and built here, at render time, into a classic script.
// `define` supplies the constants each one declares, such as THEME_PAIRS.
import { type Lang, locales } from "./i18n";
import { absolute, url } from "./site";

const cache = new Map<string, Promise<string>>();

// Every inline script of one language's page, in page order. The page renders
// these and scripts/finish.ts authorizes only these in its script policy.
export const pageScripts = async (lang: Lang) => [
  ...(lang === "en"
    ? [
      await inlineScript("detect-language", {
        SITE_ROOT: absolute("/"),
        ZH_PAGE: url(locales.zh.path),
      }),
    ]
    : []),
  await inlineScript("theme"),
];

export function inlineScript(
  name: string,
  define: Record<string, unknown> = {},
) {
  const key = name + JSON.stringify(define);
  let script = cache.get(key);
  if (!script) {
    script = build(name, define);
    cache.set(key, script);
  }
  return script;
}

async function build(name: string, define: Record<string, unknown>) {
  const result = await Bun.build({
    entrypoints: [`client/inline/${name}.ts`],
    target: "browser",
    format: "iife",
    define: Object.fromEntries(
      Object.entries(define).map(([k, v]) => [k, JSON.stringify(v)]),
    ),
  });
  if (!result.success) {
    throw new AggregateError(
      result.logs,
      `Building client/inline/${name}.ts failed`,
    );
  }
  return (await result.outputs[0]!.text()).trim().replaceAll("</", "<\\/");
}
