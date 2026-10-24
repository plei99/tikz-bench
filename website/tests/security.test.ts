import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { scriptHash, securePage } from "../lib/security";

test("the policy authorizes exact inline bytes and pins entry script integrity", () => {
  const code = '\nwindow.example = "allowed";\n';
  const inlineHash = `sha256-${
    createHash("sha256").update(code).digest("base64")
  }`;
  const entryHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const html = securePage(
    `<html><head><script>${code}</script><script type="module" src="/tikz-bench/js/app.js?v=1"></script></head><body></body></html>`,
    new Map([["/tikz-bench/js/app.js", entryHash]]),
    new Set([code]),
  );
  let policy = "";
  const inlineScripts: string[] = [];
  let body = "";
  new HTMLRewriter()
    .on('meta[http-equiv="Content-Security-Policy"]', {
      element(el) {
        policy = el.getAttribute("content")!;
      },
    })
    .on("script", {
      element(el) {
        body = "";
        el.onEndTag(() => {
          inlineScripts.push(body);
        });
      },
      text(chunk) {
        body += chunk.text;
      },
    }).transform(html);
  expect(html).toStartWith(
    '<html><head><meta http-equiv="Content-Security-Policy"',
  );
  const scriptPolicy = policy.split(";").map((d) => d.trim()).find((d) =>
    d.startsWith("script-src ")
  )!;
  expect(scriptPolicy).toContain(`'${inlineHash}'`);
  for (const script of inlineScripts) {
    const hash = createHash("sha256").update(script).digest("base64");
    expect(scriptPolicy).toContain(`'sha256-${hash}'`);
  }
  expect(scriptPolicy).toContain("'strict-dynamic'");
  for (
    const unsafe of ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https:"]
  ) {
    expect(scriptPolicy).not.toContain(unsafe);
  }
  expect(policy).toContain("base-uri 'none'");
  expect(policy).toContain("script-src-attr 'none'");
  const loaded: { src: string; integrity: string; type: string }[] = [];
  const ready: (() => void)[] = [];
  for (const script of inlineScripts) {
    runInNewContext(script, {
      window: {},
      addEventListener(_name: string, listener: () => void) {
        ready.push(listener);
      },
      document: {
        createElement: () => ({}),
        head: { append: (entry: typeof loaded[number]) => loaded.push(entry) },
      },
    });
  }
  expect(loaded).toEqual([]);
  for (const listener of ready) listener();
  expect(loaded).toEqual([
    { src: "/tikz-bench/js/app.js?v=1", integrity: entryHash, type: "module" },
  ]);
});

test("the build refuses script entries outside the compiled client scripts", () => {
  for (
    const src of [
      "https://attacker.invalid/x.js",
      "/other-project/x.js",
      "data:text/javascript,alert(1)",
    ]
  ) {
    expect(() =>
      securePage(
        `<html><head><script type="module" src="${src}"></script></head></html>`,
        new Map(),
        new Set(),
      )
    ).toThrow();
  }
});

test("the build refuses inline scripts it did not inline itself", () => {
  const theme = 'document.documentElement.dataset.theme = "dark";';
  const page = (body: string) =>
    `<html><head><script>${theme}</script></head><body>${body}</body></html>`;
  expect(() => securePage(page(""), new Map(), new Set([theme]))).not
    .toThrow();
  // Markup that reaches the page at build time, such as raw HTML in the
  // README, must fail the build rather than have its script hashed.
  expect(() =>
    securePage(
      page("<p><script>alert(document.domain)</script></p>"),
      new Map(),
      new Set([theme]),
    )
  ).toThrow("Unexpected inline script");
});

test("embedded JSON stays data and is not authorized as executable code", () => {
  const json = '{"model":"example"}';
  const html = securePage(
    `<html><head></head><body><script id="benchmark-data" type="application/json">${json}</script></body></html>`,
    new Map(),
    new Set(),
  );
  expect(html).toContain(`type="application/json">${json}</script>`);
  expect(html).not.toContain(scriptHash(json));
});
