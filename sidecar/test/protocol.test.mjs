import assert from "node:assert/strict";
import test from "node:test";

import {
  JinghuaBridgeError,
  convertOpenAiRequest as convertOpenAiRequestRaw,
  convertSaasResponse,
} from "../src/protocol.mjs";

function convertOpenAiRequest(request, sdk) {
  return convertOpenAiRequestRaw({ session_id: "thread-123", ...request }, sdk);
}

function createFakeSdk() {
  const calls = {
    decryptText: [],
    encryptText: [],
    buildGenerationTransport: [],
  };

  return {
    calls,
    async decryptText(ciphertext) {
      calls.decryptText.push(ciphertext);
      return `plain:${ciphertext}`;
    },
    async encryptText(plaintext) {
      calls.encryptText.push(plaintext);
      return `cipher:${plaintext}`;
    },
    async buildGenerationTransport(input) {
      calls.buildGenerationTransport.push(input);
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
    },
  };
}

function assertBridgeError(expectedCode, expectedStatus = 400) {
  return (error) => {
    assert.ok(error instanceof JinghuaBridgeError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    return true;
  };
}

test("loads the pinned JSSDK runtime", async () => {
  const runtime = await import("../vendor/client-tssdk/index.js");

  assert.equal(runtime.SDK_VERSION, "1.0.15");
  assert.equal(typeof runtime.ClientTSSDK, "function");
});

test("converts the supported OpenAI request into the strict SaaS shape", async () => {
  const sdk = createFakeSdk();
  const request = {
    model: "nvidia/Kimi-K2.6-NVFP4",
    messages: [
      { role: "system", content: "You are concise." },
      {
        role: "user",
        content: [
          { type: "text", text: "first line" },
          { type: "text", text: "second line" },
        ],
      },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "current question" },
    ],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 50_000,
    stop: ["", "END", "IGNORED"],
    presence_penalty: 0.2,
    frequency_penalty: -0.1,
    stream: false,
    user: "must-not-be-forwarded",
    api_key: "must-not-be-forwarded",
  };
  const originalRequest = structuredClone(request);

  const result = await convertOpenAiRequest(request, sdk);

  assert.deepEqual(request, originalRequest);
  assert.deepEqual(sdk.calls.encryptText, [
    "You are concise.",
    "first line\nsecond line",
    "previous answer",
    "current question",
  ]);
  assert.deepEqual(sdk.calls.buildGenerationTransport, [
    {
      encryptedUserData: "cipher:current question",
      sessionId: "thread-123",
    },
  ]);
  assert.deepEqual(result, {
    model: "nvidia/Kimi-K2.6-NVFP4",
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "cipher:You are concise." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "cipher:first line\nsecond line" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "cipher:previous answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "cipher:current question" }],
      },
    ],
    temperature: 0.7,
    top_p: 0.9,
    max_new_tokens: 32_768,
    stop: "END",
    presence_penalty: 0.2,
    frequency_penalty: -0.1,
    stream: false,
    include_reasoning: false,
    enable_web_search: false,
    generation_transport: {
      function: "Encryption_Generation",
      encrypted_dek: "wrapped-dek",
      encrypted_dek_len: 11,
      encrypted_timestamp: "encrypted-timestamp",
      encrypted_timestamp_len: 19,
      encrypted_system_data: "",
      encrypted_system_data_len: 0,
      encrypted_user_data: "cipher:current question",
      encrypted_user_data_len: 23,
      session_id: "thread-123",
    },
  });
  assert.equal("tools" in result, false);
  assert.equal("tool_choice" in result, false);
  assert.equal("user" in result, false);
  assert.equal("api_key" in result, false);
});

test("clamps max_tokens to the SaaS range and omits absent optional fields", async () => {
  const low = await convertOpenAiRequest(
    {
      model: "model-a",
      messages: [{ role: "user", content: "question" }],
      max_tokens: 0,
    },
    createFakeSdk(),
  );
  const absent = await convertOpenAiRequest(
    {
      model: "model-a",
      messages: [{ role: "user", content: "question" }],
    },
    createFakeSdk(),
  );

  assert.equal(low.max_new_tokens, 1);
  assert.equal("max_new_tokens" in absent, false);
  assert.equal("stop" in absent, false);
});

test("validates mapped parameters before invoking the SDK", async () => {
  const sdk = createFakeSdk();

  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [{ role: "user", content: "question" }],
        temperature: "0.7",
      },
      sdk,
    ),
    assertBridgeError("SCLAW_REQUEST_INVALID"),
  );
  assert.deepEqual(sdk.calls.encryptText, []);
  assert.deepEqual(sdk.calls.buildGenerationTransport, []);
});

test("requires a stable session id before invoking the SDK", async () => {
  const sdk = createFakeSdk();

  await assert.rejects(
    convertOpenAiRequestRaw(
      {
        model: "model-a",
        messages: [{ role: "user", content: "question" }],
      },
      sdk,
    ),
    assertBridgeError("SCLAW_SESSION_ID_REQUIRED"),
  );
  assert.deepEqual(sdk.calls.encryptText, []);
  assert.deepEqual(sdk.calls.buildGenerationTransport, []);
});

test("rejects streaming and real tool history with capability errors", async () => {
  const base = {
    model: "model-a",
    messages: [{ role: "user", content: "question" }],
  };

  await assert.rejects(
    convertOpenAiRequest({ ...base, stream: true }, createFakeSdk()),
    assertBridgeError("SCLAW_STREAM_UNSUPPORTED"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      {
        ...base,
        messages: [
          ...base.messages,
          { role: "tool", tool_call_id: "call-1", content: "result" },
        ],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_HISTORY_UNSUPPORTED"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      {
        ...base,
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-1", type: "function" }],
          },
          ...base.messages,
        ],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_HISTORY_UNSUPPORTED"),
  );
});

test("forwards tools and encrypts assistant arguments plus tool results", async () => {
  const sdk = createFakeSdk();
  const tools = [
    {
      type: "function",
      function: {
        name: "shell",
        description: "Run an approved local command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        strict: true,
      },
    },
  ];
  const result = await convertOpenAiRequest(
    {
      model: "model-a",
      messages: [
        { role: "user", content: "check the host" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-shell-1",
              type: "function",
              function: {
                name: "shell",
                arguments: '{"command":"hostname"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-shell-1",
          content: "demo-host",
        },
      ],
      tools,
      tool_choice: "required",
    },
    sdk,
  );

  assert.deepEqual(sdk.calls.encryptText, [
    "check the host",
    '{"command":"hostname"}',
    "demo-host",
  ]);
  assert.deepEqual(result.tools, tools);
  assert.equal(result.tool_choice, "required");
  assert.deepEqual(result.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "cipher:check the host" }],
    },
    {
      role: "assistant",
      content: [],
      tool_calls: [
        {
          id: "call-shell-1",
          type: "function",
          function: {
            name: "shell",
            arguments: 'cipher:{"command":"hostname"}',
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-shell-1",
      content: [{ type: "text", text: "cipher:demo-host" }],
    },
  ]);
  assert.equal(
    result.generation_transport.encrypted_user_data,
    "cipher:check the host",
  );
});

test("validates tool definitions, choices, and history links before encryption", async () => {
  const base = {
    model: "model-a",
    messages: [{ role: "user", content: "question" }],
  };
  const tool = {
    type: "function",
    function: { name: "shell", parameters: { type: "object" } },
  };

  await assert.rejects(
    convertOpenAiRequest(
      { ...base, tools: [], tool_choice: "required" },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_CALLING_INVALID_REQUEST"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      { ...base, tools: [tool, structuredClone(tool)] },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_CALLING_INVALID_REQUEST"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      { ...base, tools: [tool], enable_web_search: true },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_CALLING_INVALID_REQUEST"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      {
        ...base,
        tools: [tool],
        messages: [
          ...base.messages,
          { role: "tool", tool_call_id: "missing", content: "result" },
        ],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TOOL_CALLING_INVALID_REQUEST"),
  );
});

test("rejects non-text blocks and requests without a non-empty user message", async () => {
  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "local" } }],
          },
        ],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_TEXT_ONLY"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [{ role: "system", content: "instructions" }],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_USER_MESSAGE_REQUIRED"),
  );
  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [{ role: "user", content: "   " }],
      },
      createFakeSdk(),
    ),
    assertBridgeError("SCLAW_USER_MESSAGE_REQUIRED"),
  );
});

test("decrypts the first SaaS choice into a standard OpenAI response", async () => {
  const sdk = createFakeSdk();
  const upstream = {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_780_000_000,
    model: "model-a",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "cipher-1" },
            { type: "text", text: "cipher-2" },
          ],
          reasoning: [{ type: "text", text: "ignored" }],
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
    web_search_sources: [{ title: "ignored" }],
  };
  const originalUpstream = structuredClone(upstream);

  const result = await convertSaasResponse(upstream, sdk);

  assert.deepEqual(upstream, originalUpstream);
  assert.deepEqual(sdk.calls.decryptText, ["cipher-1", "cipher-2"]);
  assert.deepEqual(result, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_780_000_000,
    model: "model-a",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "plain:cipher-1\nplain:cipher-2",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  });
});

test("decrypts parallel tool-only calls into standard OpenAI tool_calls", async () => {
  const sdk = createFakeSdk();
  const result = await convertSaasResponse(
    {
      id: "chatcmpl-tools",
      object: "chat.completion",
      created: 1_780_000_001,
      model: "model-a",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [],
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "shell", arguments: "cipher-args-1" },
              },
              {
                id: "call-2",
                type: "function",
                function: { name: "shell", arguments: "cipher-args-2" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    },
    sdk,
  );

  assert.deepEqual(sdk.calls.decryptText, ["cipher-args-1", "cipher-args-2"]);
  assert.equal(result.choices[0].message.content, null);
  assert.deepEqual(result.choices[0].message.tool_calls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "shell", arguments: "plain:cipher-args-1" },
    },
    {
      id: "call-2",
      type: "function",
      function: { name: "shell", arguments: "plain:cipher-args-2" },
    },
  ]);
  assert.equal(result.choices[0].finish_reason, "tool_calls");
});

test("uses static error text when SDK failures contain sensitive values", async () => {
  const sensitiveValues = [
    "plain-user-question",
    "api-key-secret",
    "dek-secret",
  ];
  const sdk = createFakeSdk();
  sdk.encryptText = async () => {
    throw new Error(sensitiveValues.join(" "));
  };

  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [{ role: "user", content: sensitiveValues[0] }],
        api_key: sensitiveValues[1],
      },
      sdk,
    ),
    (error) => {
      assertBridgeError("SCLAW_ENCRYPTION_FAILED", 500)(error);
      const serialized = `${error.name}: ${error.message}\n${JSON.stringify(error)}`;
      for (const value of sensitiveValues) {
        assert.equal(serialized.includes(value), false);
      }
      return true;
    },
  );

  const transportingSdk = createFakeSdk();
  transportingSdk.buildGenerationTransport = async () => {
    throw new Error(sensitiveValues.join(" "));
  };
  await assert.rejects(
    convertOpenAiRequest(
      {
        model: "model-a",
        messages: [{ role: "user", content: "safe-question" }],
      },
      transportingSdk,
    ),
    (error) => {
      assertBridgeError("SCLAW_TRANSPORT_FAILED", 500)(error);
      const serialized = `${error.name}: ${error.message}\n${JSON.stringify(error)}`;
      for (const value of sensitiveValues) {
        assert.equal(serialized.includes(value), false);
      }
      return true;
    },
  );

  const decryptingSdk = createFakeSdk();
  decryptingSdk.decryptText = async () => {
    throw new Error(sensitiveValues.join(" "));
  };
  await assert.rejects(
    convertSaasResponse(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "model-a",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ciphertext" }],
            },
            finish_reason: "stop",
          },
        ],
      },
      decryptingSdk,
    ),
    (error) => {
      assertBridgeError("SCLAW_DECRYPTION_FAILED", 502)(error);
      const serialized = `${error.name}: ${error.message}\n${JSON.stringify(error)}`;
      for (const value of sensitiveValues) {
        assert.equal(serialized.includes(value), false);
      }
      return true;
    },
  );
});
