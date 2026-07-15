import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { startSidecar } from "../src/server.mjs";

function createSdkHarness() {
  const state = { instances: [] };

  class FakeClientTSSDK {
    version = "test-sdk-1.0.15";

    constructor(options) {
      this.options = options;
      this.calls = {
        init: 0,
        envInit: 0,
        destroy: 0,
        encryptText: [],
        decryptText: [],
        buildGenerationTransport: [],
      };
      state.instances.push(this);
    }

    async init() {
      this.calls.init += 1;
    }

    async envInit() {
      this.calls.envInit += 1;
    }

    destroy() {
      this.calls.destroy += 1;
    }

    async encryptText(plaintext) {
      this.calls.encryptText.push(plaintext);
      return `cipher:${plaintext}`;
    }

    async decryptText(ciphertext) {
      this.calls.decryptText.push(ciphertext);
      return `plain:${ciphertext}`;
    }

    async buildGenerationTransport(input) {
      this.calls.buildGenerationTransport.push(input);
      return {
        function: "Encryption_Generation",
        encrypted_dek: "wrapped-dek",
        encrypted_dek_len: 11,
        encrypted_timestamp: "encrypted-timestamp",
        encrypted_timestamp_len: 19,
        encrypted_system_data: "",
        encrypted_system_data_len: 0,
        encrypted_user_data: input.encryptedUserData,
        encrypted_user_data_len: input.encryptedUserData.length,
        session_id: input.sessionId ?? null,
      };
    }
  }

  return { FakeClientTSSDK, state };
}

async function startTestSidecar(overrides = {}) {
  const sdkHarness = createSdkHarness();
  const logs = [];
  const sidecar = await startSidecar({
    ClientTSSDKClass: sdkHarness.FakeClientTSSDK,
    upstreamBaseUrl: "https://saas.test/",
    fetchImpl: async () => new Response(JSON.stringify({ data: [] })),
    port: 0,
    logger: (entry) => logs.push(entry),
    ...overrides,
  });
  return {
    sidecar,
    sdk: sdkHarness.state.instances[0],
    logs,
    baseUrl: `http://${sidecar.host}:${sidecar.port}`,
  };
}

test("initializes the SDK before exposing loopback health", async (t) => {
  const context = await startTestSidecar();
  t.after(() => context.sidecar.shutdown());

  assert.equal(context.sidecar.host, "127.0.0.1");
  assert.deepEqual(context.sdk.options, {
    appName: "sclaw-node-sidecar",
    apiBaseUrl: "https://saas.test",
  });
  assert.equal(context.sdk.calls.init, 1);
  assert.equal(context.sdk.calls.envInit, 1);

  const response = await fetch(`${context.baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    sdkVersion: "test-sdk-1.0.15",
    upstream: "https://saas.test",
  });
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

test("forwards models with Authorization without logging credentials", async (t) => {
  const upstreamCalls = [];
  const apiKey = "test-api-key-secret";
  const context = await startTestSidecar({
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url, options });
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
      });
    },
  });
  t.after(() => context.sidecar.shutdown());

  const unauthorized = await fetch(`${context.baseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);
  assert.equal(
    (await unauthorized.json()).error.code,
    "SCLAW_AUTH_REQUIRED",
  );

  const response = await fetch(`${context.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "model-a" }] });
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "https://saas.test/v1/models");
  assert.equal(
    upstreamCalls[0].options.headers.authorization,
    `Bearer ${apiKey}`,
  );
  assert.equal(JSON.stringify(context.logs).includes(apiKey), false);
});

test("encrypts chat upstream and returns decrypted OpenAI string content", async (t) => {
  const upstreamCalls = [];
  const apiKey = "test-api-key-secret";
  const plaintext = "current private question";
  const context = await startTestSidecar({
    fetchImpl: async (url, options) => {
      upstreamCalls.push({
        url,
        options: {
          ...options,
          body: JSON.parse(options.body),
        },
      });
      return new Response(JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1_780_000_000,
        model: "model-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "response-cipher-1" },
              { type: "text", text: "response-cipher-2" },
            ],
          },
          finish_reason: "stop",
        }],
        usage: { total_tokens: 3 },
      }), { status: 200 });
    },
  });
  t.after(() => context.sidecar.shutdown());

  const response = await fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      model: "model-a",
      session_id: "thread-123",
      messages: [
        { role: "system", content: "system instructions" },
        { role: "user", content: plaintext },
      ],
      max_tokens: 2048,
      stream: false,
    }),
  });

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(
    result.choices[0].message.content,
    "plain:response-cipher-1\nplain:response-cipher-2",
  );
  assert.equal(upstreamCalls.length, 1);
  assert.equal(
    upstreamCalls[0].url,
    "https://saas.test/v1/chat/completions",
  );
  assert.equal(
    upstreamCalls[0].options.headers.authorization,
    `Bearer ${apiKey}`,
  );
  assert.deepEqual(upstreamCalls[0].options.body.messages, [
    {
      role: "system",
      content: [{ type: "text", text: "cipher:system instructions" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: `cipher:${plaintext}` }],
    },
  ]);
  assert.equal(
    upstreamCalls[0].options.body.generation_transport.encrypted_user_data,
    `cipher:${plaintext}`,
  );
  assert.equal(
    upstreamCalls[0].options.body.generation_transport.session_id,
    "thread-123",
  );
  assert.equal(upstreamCalls[0].options.body.stream, false);
  assert.equal("tools" in upstreamCalls[0].options.body, false);
  assert.equal("tool_choice" in upstreamCalls[0].options.body, false);
  const serializedLogs = JSON.stringify(context.logs);
  assert.equal(serializedLogs.includes(apiKey), false);
  assert.equal(serializedLogs.includes(plaintext), false);
  assert.equal(serializedLogs.includes("wrapped-dek"), false);
  assert.deepEqual(context.sdk.calls.decryptText, [
    "response-cipher-1",
    "response-cipher-2",
  ]);
});

test("completes a Fake SaaS tool call and encrypted result continuation", async (t) => {
  const upstreamBodies = [];
  const context = await startTestSidecar({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      upstreamBodies.push(body);
      if (upstreamBodies.length === 1) {
        return new Response(JSON.stringify({
          id: "chatcmpl-tool-1",
          object: "chat.completion",
          created: 1,
          model: "model-a",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: [],
              tool_calls: [{
                id: "call-shell-1",
                type: "function",
                function: {
                  name: "shell",
                  arguments: "cipher-tool-arguments",
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "chatcmpl-tool-2",
        object: "chat.completion",
        created: 2,
        model: "model-a",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "cipher-final-answer" }],
          },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }), { status: 200 });
    },
  });
  t.after(() => context.sidecar.shutdown());

  const tools = [{
    type: "function",
    function: {
      name: "shell",
      description: "Run a local command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  }];
  const request = async (messages) => {
    const response = await fetch(`${context.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "model-a",
        session_id: "thread-tool",
        messages,
        tools,
        tool_choice: "auto",
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await request([{ role: "user", content: "show hostname" }]);
  const toolCall = first.choices[0].message.tool_calls[0];
  assert.equal(first.choices[0].message.content, null);
  assert.equal(toolCall.function.arguments, "plain:cipher-tool-arguments");

  // Represents SClaw's existing local permission/execution loop.
  const localToolResult = "demo-host";
  const second = await request([
    { role: "user", content: "show hostname" },
    {
      role: "assistant",
      content: null,
      tool_calls: [toolCall],
    },
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: localToolResult,
    },
  ]);

  assert.equal(second.choices[0].message.content, "plain:cipher-final-answer");
  assert.deepEqual(upstreamBodies[0].tools, tools);
  assert.equal(upstreamBodies[0].tool_choice, "auto");
  assert.equal(
    upstreamBodies[1].messages[1].tool_calls[0].function.arguments,
    "cipher:plain:cipher-tool-arguments",
  );
  assert.equal(
    upstreamBodies[1].messages[2].content[0].text,
    `cipher:${localToolResult}`,
  );
  assert.equal(
    upstreamBodies[1].generation_transport.encrypted_user_data,
    "cipher:show hostname",
  );
  const toolLogs = context.logs.filter((entry) => entry.model === "model-a");
  assert.equal(toolLogs.length, 2);
  assert.deepEqual(
    toolLogs.map((entry) => ({
      toolsEnabled: entry.toolsEnabled,
      toolCount: entry.toolCount,
      toolCallCount: entry.toolCallCount,
      finishReason: entry.finishReason,
    })),
    [
      {
        toolsEnabled: true,
        toolCount: 1,
        toolCallCount: 1,
        finishReason: "tool_calls",
      },
      {
        toolsEnabled: true,
        toolCount: 1,
        toolCallCount: 0,
        finishReason: "stop",
      },
    ],
  );
  const serializedLogs = JSON.stringify(toolLogs);
  for (const secret of [
    "Run a local command",
    "cipher-tool-arguments",
    localToolResult,
    "cipher-final-answer",
  ]) {
    assert.equal(serializedLogs.includes(secret), false);
  }
});

test("rejects invalid HTTP chat requests before calling upstream", async (t) => {
  let upstreamCalls = 0;
  const context = await startTestSidecar({
    bodyLimitBytes: 64,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response("{}");
    },
  });
  t.after(() => context.sidecar.shutdown());
  const authorization = "Bearer test-key";

  const missingContentType = await fetch(
    `${context.baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: { authorization },
      body: "{}",
    },
  );
  assert.equal(missingContentType.status, 415);
  assert.equal(
    (await missingContentType.json()).error.code,
    "SCLAW_CONTENT_TYPE_UNSUPPORTED",
  );

  const invalidJson = await fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "not-json",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(
    (await invalidJson.json()).error.code,
    "SCLAW_REQUEST_INVALID",
  );

  const tooLarge = await fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(128) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(
    (await tooLarge.json()).error.code,
    "SCLAW_BODY_TOO_LARGE",
  );

  assert.equal(upstreamCalls, 0);
});

test("returns capability errors, upstream errors, and timeout safely", async (t) => {
  let mode = "passthrough";
  const context = await startTestSidecar({
    upstreamTimeoutMs: 10,
    fetchImpl: async (_url, options) => {
      if (mode === "passthrough") {
        return new Response(JSON.stringify({
          error: { type: "upstream_error", message: "denied" },
        }), { status: 429 });
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  });
  t.after(() => context.sidecar.shutdown());

  const sendChat = (body) => fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const request = {
    model: "model-a",
    session_id: "thread-123",
    messages: [{ role: "user", content: "question" }],
  };

  const streaming = await sendChat({ ...request, stream: true });
  assert.equal(streaming.status, 400);
  assert.equal(
    (await streaming.json()).error.code,
    "SCLAW_STREAM_UNSUPPORTED",
  );

  const upstreamError = await sendChat(request);
  assert.equal(upstreamError.status, 429);
  assert.deepEqual(await upstreamError.json(), {
    error: { type: "upstream_error", message: "denied" },
  });

  mode = "timeout";
  const timeout = await sendChat(request);
  assert.equal(timeout.status, 504);
  assert.equal(
    (await timeout.json()).error.code,
    "SCLAW_UPSTREAM_TIMEOUT",
  );
});

test("keeps the upstream timeout active while reading the response body", async (t) => {
  const context = await startTestSidecar({
    upstreamTimeoutMs: 10,
    fetchImpl: async (_url, options) => ({
      status: 200,
      ok: true,
      json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
    }),
  });
  t.after(() => context.sidecar.shutdown());

  const response = await fetch(`${context.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "model-a",
      session_id: "thread-123",
      messages: [{ role: "user", content: "question" }],
    }),
  });

  assert.equal(response.status, 504);
  assert.equal(
    (await response.json()).error.code,
    "SCLAW_UPSTREAM_TIMEOUT",
  );
});

test("shutdown is idempotent and destroys the SDK", async () => {
  const context = await startTestSidecar();

  await Promise.all([
    context.sidecar.shutdown(),
    context.sidecar.shutdown(),
  ]);

  assert.equal(context.sdk.calls.destroy, 1);
  await assert.rejects(fetch(`${context.baseUrl}/health`));
});

async function waitForReady(child) {
  let stdout = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    for await (const chunk of child.stdout) {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        return;
      }
    }
    throw new Error(`sidecar child exited before ready: ${stdout}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertChildStops(trigger) {
  const serverModuleUrl = new URL("../src/server.mjs", import.meta.url).href;
  const program = `
    import { startSidecar, installProcessShutdown } from ${JSON.stringify(serverModuleUrl)};
    class FakeClientTSSDK {
      version = "test";
      async init() {}
      async envInit() {}
      destroy() {}
    }
    const sidecar = await startSidecar({
      ClientTSSDKClass: FakeClientTSSDK,
      upstreamBaseUrl: "https://saas.test",
      fetchImpl: async () => new Response("{}"),
      port: 0,
      logger: () => {},
    });
    installProcessShutdown(sidecar);
    process.stdout.write("READY\\n");
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", program],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  await waitForReady(child);
  trigger(child);

  const forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000);
  const [code, signal] = await once(child, "close");
  clearTimeout(forceKill);
  const stderr = await new Response(child.stderr).text();

  assert.equal(code, 0, stderr);
  assert.equal(signal, null, stderr);
}

test("stdin EOF and SIGTERM both stop the sidecar process", async () => {
  await assertChildStops((child) => child.stdin.end());
  await assertChildStops((child) => child.kill("SIGTERM"));
});
