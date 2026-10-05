import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import extension, {
  limitRequestImages,
  requestImageLimit,
  type ImageMessage,
} from "../src/pi_image_limits.ts";
import { temporary, capture, which } from "../src/process.ts";
import { command, runtimeFiles, PI_IMAGE_LIMITS_PATH } from "../src/runner.ts";

const image = (data: string) => ({
  type: "image",
  mimeType: "image/png",
  data,
});
const text = (value: string) => ({ type: "text", text: value });
const count = (messages: ImageMessage[]) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === "image");

test("image limiting pins the reference and newest distinct crops without changing saved history", () => {
  const messages: ImageMessage[] = [
    { role: "user", content: [text("Draw this"), image("reference")] },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: { path: "crop.png" },
        },
      ],
    },
    ...Array.from({ length: 6 }, (_, n) => ({
      role: "toolResult",
      toolCallId: "call-" + n,
      content: [text("crop-" + n), image("crop-" + n)],
    })),
  ];
  const original = structuredClone(messages);
  const limited = limitRequestImages(messages, 4);
  assert.deepEqual(
    count(limited.messages).map((p) => p.data),
    ["reference", "crop-3", "crop-4", "crop-5"],
  );
  assert.deepEqual(messages, original);
  assert.equal(limited.messages.length, messages.length);
  assert.deepEqual(limited.messages[1], messages[1]);
  assert.equal(limited.messages[2]!.toolCallId, "call-0");
  assert.deepEqual((limited.messages[2]!.content as any[])[0], text("crop-0"));
  assert.match(
    (limited.messages[2]!.content as any[])[1].text,
    /image omitted/,
  );
  assert.deepEqual(
    { before: limited.before, after: limited.after },
    { before: 7, after: 4 },
  );
  assert.strictEqual(
    limitRequestImages(limited.messages, 4).messages,
    limited.messages,
  );
});

test("duplicate rereads do not displace the reference or recent distinct crops", () => {
  const messages: ImageMessage[] = [
    { role: "user", content: [image("reference")] },
    { role: "toolResult", content: [image("old"), image("new")] },
    {
      role: "toolResult",
      content: [image("reference"), image("new"), image("latest")],
    },
  ];
  const limited = limitRequestImages(messages, 3);
  assert.deepEqual(
    count(limited.messages).map((p) => p.data),
    ["reference", "new", "latest"],
  );
  assert.deepEqual(
    count(limitRequestImages(messages, 1).messages).map((p) => p.data),
    ["reference"],
  );
});

test("declared model limits override the observed MiMo fallback; other models have no invented limit", () => {
  const mimo = { provider: "openrouter", id: "xiaomi/mimo-v2.6-pro" };
  assert.equal(requestImageLimit(mimo), 4);
  assert.equal(
    requestImageLimit({
      ...mimo,
      inputLimits: { images: { maxPerRequest: 8 } },
    }),
    8,
  );
  assert.equal(
    requestImageLimit({ provider: "other", id: "model" }),
    undefined,
  );
  assert.equal(
    requestImageLimit({
      provider: "other",
      id: "model",
      inputLimits: { images: { maxPerRequest: -1 } },
    }),
    undefined,
  );
  assert.throws(() => limitRequestImages([], 0));
});

test("the context hook records omissions outside model context and leaves compliant requests intact", () => {
  let handler: any;
  const audit: any[] = [];
  extension({
    on(event, callback) {
      assert.equal(event, "context");
      handler = callback;
    },
    appendEntry(type, data) {
      audit.push({ type, data });
    },
  });
  const model = { provider: "openrouter", id: "xiaomi/mimo-v2.6-pro" };
  const messages = [{ role: "user", content: [image("reference")] }];
  assert.equal(handler({ messages }, { model }), undefined);
  assert.equal(audit.length, 0);
  const long = [
    ...messages,
    {
      role: "toolResult",
      content: Array.from({ length: 5 }, (_, i) => image("crop-" + i)),
    },
  ];
  assert.equal(
    count(handler({ messages: long }, { model }).messages).length,
    4,
  );
  assert.equal(audit[0].type, "benchmark-image-limits-v1");
  assert.deepEqual(audit[0].data, {
    provider: "openrouter",
    model: "xiaomi/mimo-v2.6-pro",
    limit: 4,
    before: 6,
    after: 4,
  });
  assert.equal(
    handler(
      { messages: long },
      { model: { provider: "other", id: "unknown" } },
    ),
    undefined,
  );
});

let pi: string | undefined;
try {
  pi = which("pi");
} catch {}
test(
  "real pi sends at most four images through repeated read calls to a local mock provider",
  { skip: !pi },
  async () =>
    temporary("tikz-pi-limits-", async (dir) => {
      const requests: any[] = [];
      let serverError: string | undefined;
      const server = http.createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const urls = body.messages
            .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
            .filter((p: any) => p.type === "image_url")
            .map((p: any) => p.image_url.url);
          if (urls.length > 4) {
            serverError = `Too many images in request: ${urls.length} > 4`;
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: serverError } }));
            return;
          }
          const turn = requests.length;
          requests.push({ urls, model: body.model });
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const delta =
            turn < 6
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-" + turn,
                      type: "function",
                      function: {
                        name: "read",
                        arguments: JSON.stringify({
                          path: path.join(dir, `image-${turn + 1}.png`),
                        }),
                      },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content: "Finished the image-limit fixture.",
                };
          const chunk = {
            id: "fixture-" + turn,
            object: "chat.completion.chunk",
            created: 1,
            model: "vision-limit-fixture",
          };
          res.write(
            "data: " +
              JSON.stringify({
                ...chunk,
                choices: [{ index: 0, delta, finish_reason: null }],
              }) +
              "\n\n",
          );
          res.write(
            "data: " +
              JSON.stringify({
                ...chunk,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: turn < 6 ? "tool_calls" : "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              }) +
              "\n\n",
          );
          res.end("data: [DONE]\n\n");
        } catch (e) {
          serverError = String(e);
          res.writeHead(500);
          res.end("fixture failed");
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const home = path.join(dir, "home"),
          agentDir = path.join(home, "pi-agent"),
          sessions = path.join(agentDir, "sessions");
        fs.mkdirSync(sessions, { recursive: true });
        for (let n = 0; n < 7; n++)
          await sharp({
            create: {
              width: 4,
              height: 4,
              channels: 3,
              background: { r: n * 30, g: 100, b: 200 - n * 20 },
            },
          })
            .png()
            .toFile(path.join(dir, `image-${n}.png`));
        const address = server.address() as { port: number };
        fs.writeFileSync(
          path.join(agentDir, "models.json"),
          JSON.stringify({
            providers: {
              fixture: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                api: "openai-completions",
                apiKey: "fixture-not-a-real-key",
                models: [
                  {
                    id: "vision-limit-fixture",
                    reasoning: false,
                    input: ["text", "image"],
                    contextWindow: 100000,
                    maxTokens: 1000,
                    inputLimits: { images: { maxPerRequest: 4 } },
                  },
                ],
              },
            },
          }),
        );
        const extensionPath = path.join(agentDir, "benchmark_image_limits.ts");
        fs.writeFileSync(
          extensionPath,
          runtimeFiles("pi", "fixture/vision-limit-fixture", [])[
            PI_IMAGE_LIMITS_PATH
          ]!,
        );
        const argv = command({
          agent: "pi",
          model: "fixture/vision-limit-fixture",
          prompt: "Read the fixture images requested by the test server.",
        }).map((arg) =>
          arg === "pi"
            ? pi!
            : arg === PI_IMAGE_LIMITS_PATH
              ? extensionPath
              : arg === "@/workspace/reference.png"
                ? "@" + path.join(dir, "image-0.png")
                : arg,
        );
        argv.splice(
          argv.length - 1,
          0,
          "--offline",
          "--tools",
          "read",
          "--session-dir",
          sessions,
        );
        const result = await capture(argv, {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          timeout: 45,
        });
        assert.equal(serverError, undefined);
        assert.equal(result.returncode, 0, result.stderr);
        assert.equal(requests.length, 7, result.stdout.slice(-2000));
        assert.deepEqual(
          requests.map((r) => r.urls.length),
          [1, 2, 3, 4, 4, 4, 4],
        );
        const original = requests[0].urls[0];
        assert.ok(requests.every((r) => r.urls.includes(original)));
        assert.deepEqual(requests[6].urls, [
          original,
          ...requests.slice(4, 7).map((r) => r.urls.at(-1)),
        ]);
        const files = fs
          .readdirSync(sessions)
          .filter((n) => n.endsWith(".jsonl"));
        assert.equal(files.length, 1);
        const events = fs
          .readFileSync(path.join(sessions, files[0]!), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        assert.equal(
          count(
            events.filter((e) => e.type === "message").map((e) => e.message),
          ).length,
          7,
        );
        assert.equal(
          events.filter(
            (e) =>
              e.type === "custom" &&
              e.customType === "benchmark-image-limits-v1",
          ).length,
          3,
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }),
);
