const ERROR_DEFINITIONS = {
  SCLAW_AUTH_REQUIRED: {
    status: 401,
    message: "缺少有效的 Bearer Authorization Header",
  },
  SCLAW_CONTENT_TYPE_UNSUPPORTED: {
    status: 415,
    message: "Content-Type 必须是 application/json",
  },
  SCLAW_BODY_TOO_LARGE: {
    status: 413,
    message: "请求体超过 2 MiB 限制",
  },
  SCLAW_REQUEST_INVALID: {
    status: 400,
    message: "请求体不符合密态 SClaw MVP 协议",
  },
  SCLAW_STREAM_UNSUPPORTED: {
    status: 400,
    message: "MVP 暂不支持流式输出，请将 stream 设置为 false",
  },
  SCLAW_TOOL_HISTORY_UNSUPPORTED: {
    status: 400,
    message: "工具调用历史必须与有效的 tools 定义一起发送",
  },
  SCLAW_TOOL_CALLING_INVALID_REQUEST: {
    status: 400,
    message: "工具调用请求不符合 OpenAI function tools 协议",
  },
  SCLAW_TEXT_ONLY: {
    status: 400,
    message: "MVP 只支持非空纯文本消息",
  },
  SCLAW_USER_MESSAGE_REQUIRED: {
    status: 400,
    message: "MVP 请求必须包含一条非空 user 消息",
  },
  SCLAW_SESSION_ID_REQUIRED: {
    status: 400,
    message: "MVP 请求必须包含有效的 session_id",
  },
  SCLAW_ENCRYPTION_FAILED: {
    status: 500,
    message: "本地消息加密失败",
  },
  SCLAW_TRANSPORT_FAILED: {
    status: 500,
    message: "本地 generation transport 构造失败",
  },
  SCLAW_UPSTREAM_UNAVAILABLE: {
    status: 502,
    message: "无法连接荆华 SaaS",
  },
  SCLAW_UPSTREAM_TIMEOUT: {
    status: 504,
    message: "荆华 SaaS 请求超时",
  },
  SCLAW_UPSTREAM_JSON_INVALID: {
    status: 502,
    message: "SaaS 返回了无效的 JSON 响应",
  },
  SCLAW_UPSTREAM_RESPONSE_INVALID: {
    status: 502,
    message: "SaaS 返回了无效的非流式密文响应",
  },
  SCLAW_DECRYPTION_FAILED: {
    status: 502,
    message: "本地响应解密失败",
  },
};

export class JinghuaBridgeError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code];
    if (!definition) {
      throw new TypeError("Unknown Jinghua bridge error code");
    }

    super(definition.message);
    this.name = "JinghuaBridgeError";
    this.type = "jinghua_bridge_error";
    this.code = code;
    this.status = definition.status;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
      },
    };
  }
}

function fail(code) {
  throw new JinghuaBridgeError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractText(content) {
  if (typeof content === "string") {
    return content.trim() ? content : "";
  }

  if (!Array.isArray(content)) {
    fail("SCLAW_TEXT_ONLY");
  }

  const textBlocks = content.map((block) => {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") {
      fail("SCLAW_TEXT_ONLY");
    }
    return block.text;
  });

  return textBlocks.filter((text) => text.trim()).join("\n");
}

function normalizeTools(rawTools) {
  if (rawTools == null) {
    return [];
  }
  if (!Array.isArray(rawTools)) {
    fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
  }

  const names = new Set();
  return rawTools.map((tool) => {
    if (!isObject(tool) || tool.type !== "function" || !isObject(tool.function)) {
      fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
    }
    const { name, description, parameters, strict } = tool.function;
    if (
      typeof name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(name) ||
      names.has(name) ||
      !isObject(parameters) ||
      (description != null && typeof description !== "string") ||
      (strict != null && typeof strict !== "boolean")
    ) {
      fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
    }
    names.add(name);

    return {
      type: "function",
      function: {
        name,
        ...(description == null ? {} : { description }),
        parameters: structuredClone(parameters),
        ...(strict == null ? {} : { strict }),
      },
    };
  });
}

function normalizeToolChoice(rawChoice, tools) {
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  if (rawChoice == null) {
    return tools.length > 0 ? "auto" : undefined;
  }

  if (typeof rawChoice === "string") {
    if (!["auto", "none", "required"].includes(rawChoice)) {
      fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
    }
    if (tools.length === 0) {
      if (rawChoice === "required") {
        fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
      }
      return undefined;
    }
    return rawChoice;
  }

  const functionName = rawChoice?.function?.name;
  if (
    tools.length === 0 ||
    !isObject(rawChoice) ||
    rawChoice.type !== "function" ||
    !isObject(rawChoice.function) ||
    typeof functionName !== "string" ||
    !toolNames.has(functionName)
  ) {
    fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
  }
  return {
    type: "function",
    function: { name: functionName },
  };
}

async function encryptText(text, sdk) {
  let ciphertext;
  try {
    ciphertext = await sdk.encryptText(text);
  } catch {
    fail("SCLAW_ENCRYPTION_FAILED");
  }
  if (typeof ciphertext !== "string" || !ciphertext) {
    fail("SCLAW_ENCRYPTION_FAILED");
  }
  return ciphertext;
}

async function normalizeAndEncryptMessages(messages, tools, sdk) {
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  const callsById = new Map();
  const completedCallIds = new Set();
  const encryptedMessages = [];
  let lastEncryptedUserText;

  for (const message of messages) {
    if (!isObject(message)) {
      fail("SCLAW_REQUEST_INVALID");
    }

    if (["system", "user"].includes(message.role)) {
      const text = extractText(message.content);
      if (!text) {
        fail(message.role === "user" ? "SCLAW_USER_MESSAGE_REQUIRED" : "SCLAW_TEXT_ONLY");
      }
      const ciphertext = await encryptText(text, sdk);
      encryptedMessages.push({
        role: message.role,
        content: [{ type: "text", text: ciphertext }],
      });
      if (message.role === "user") {
        lastEncryptedUserText = ciphertext;
      }
      continue;
    }

    if (message.role === "assistant") {
      if (message.function_call != null) {
        fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
      }
      const rawToolCalls = message.tool_calls;
      const hasToolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0;
      if (rawToolCalls != null && !hasToolCalls) {
        fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
      }
      if (hasToolCalls && tools.length === 0) {
        fail("SCLAW_TOOL_HISTORY_UNSUPPORTED");
      }

      const text = message.content == null ? "" : extractText(message.content);
      if (!text && !hasToolCalls) {
        fail("SCLAW_TEXT_ONLY");
      }
      const encryptedMessage = {
        role: "assistant",
        content: text
          ? [{ type: "text", text: await encryptText(text, sdk) }]
          : [],
      };

      if (hasToolCalls) {
        encryptedMessage.tool_calls = [];
        for (const toolCall of rawToolCalls) {
          const id = toolCall?.id;
          const functionName = toolCall?.function?.name;
          const argumentsText = toolCall?.function?.arguments;
          if (
            !isObject(toolCall) ||
            typeof id !== "string" ||
            !id.trim() ||
            callsById.has(id) ||
            toolCall.type !== "function" ||
            !isObject(toolCall.function) ||
            typeof functionName !== "string" ||
            !toolNames.has(functionName) ||
            typeof argumentsText !== "string" ||
            !argumentsText.trim()
          ) {
            fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
          }
          callsById.set(id, functionName);
          encryptedMessage.tool_calls.push({
            id,
            type: "function",
            function: {
              name: functionName,
              arguments: await encryptText(argumentsText, sdk),
            },
          });
        }
      }
      encryptedMessages.push(encryptedMessage);
      continue;
    }

    if (message.role === "tool") {
      if (tools.length === 0) {
        fail("SCLAW_TOOL_HISTORY_UNSUPPORTED");
      }
      const toolCallId = message.tool_call_id;
      if (
        typeof toolCallId !== "string" ||
        !toolCallId.trim() ||
        !callsById.has(toolCallId) ||
        completedCallIds.has(toolCallId)
      ) {
        fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
      }
      completedCallIds.add(toolCallId);
      const text = extractText(message.content);
      if (!text) {
        fail("SCLAW_TEXT_ONLY");
      }
      encryptedMessages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: [{ type: "text", text: await encryptText(text, sdk) }],
      });
      continue;
    }

    fail("SCLAW_REQUEST_INVALID");
  }

  if (!lastEncryptedUserText) {
    fail("SCLAW_USER_MESSAGE_REQUIRED");
  }
  return { encryptedMessages, lastEncryptedUserText };
}

function copyOptionalNumber(source, target, key) {
  const value = source[key];
  if (value == null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("SCLAW_REQUEST_INVALID");
  }
  target[key] = value;
}

function mapStop(stop) {
  if (stop == null) {
    return undefined;
  }
  if (typeof stop === "string") {
    return stop;
  }
  if (!Array.isArray(stop)) {
    fail("SCLAW_REQUEST_INVALID");
  }
  return stop.find((item) => typeof item === "string" && item.trim());
}

function mapRequestOptions(request) {
  const options = {};
  copyOptionalNumber(request, options, "temperature");
  copyOptionalNumber(request, options, "top_p");
  copyOptionalNumber(request, options, "presence_penalty");
  copyOptionalNumber(request, options, "frequency_penalty");

  if (request.max_tokens != null) {
    if (!Number.isInteger(request.max_tokens)) {
      fail("SCLAW_REQUEST_INVALID");
    }
    options.max_new_tokens = Math.min(
      Math.max(request.max_tokens, 1),
      32_768,
    );
  }

  const stop = mapStop(request.stop);
  if (stop !== undefined) {
    options.stop = stop;
  }

  return options;
}

function validateRequest(request) {
  if (!isObject(request)) {
    fail("SCLAW_REQUEST_INVALID");
  }
  if (request.stream === true) {
    fail("SCLAW_STREAM_UNSUPPORTED");
  }
  if (request.stream !== undefined && request.stream !== false) {
    fail("SCLAW_REQUEST_INVALID");
  }
  if (typeof request.model !== "string" || !request.model.trim()) {
    fail("SCLAW_REQUEST_INVALID");
  }
  if (typeof request.session_id !== "string" || !request.session_id.trim()) {
    fail("SCLAW_SESSION_ID_REQUIRED");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    fail("SCLAW_USER_MESSAGE_REQUIRED");
  }
}

export async function convertOpenAiRequest(request, sdk) {
  validateRequest(request);
  const requestOptions = mapRequestOptions(request);
  const tools = normalizeTools(request.tools);
  const toolChoice = normalizeToolChoice(request.tool_choice, tools);
  if (tools.length > 0 && request.enable_web_search === true) {
    fail("SCLAW_TOOL_CALLING_INVALID_REQUEST");
  }
  const { encryptedMessages, lastEncryptedUserText } =
    await normalizeAndEncryptMessages(request.messages, tools, sdk);

  let generationTransport;
  try {
    generationTransport = await sdk.buildGenerationTransport({
      encryptedUserData: lastEncryptedUserText,
      sessionId: request.session_id.trim(),
    });
  } catch {
    fail("SCLAW_TRANSPORT_FAILED");
  }
  if (!isObject(generationTransport)) {
    fail("SCLAW_TRANSPORT_FAILED");
  }

  const result = {
    model: request.model,
    messages: encryptedMessages,
    ...requestOptions,
    stream: false,
    include_reasoning: false,
    enable_web_search: false,
    generation_transport: generationTransport,
    ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
  };

  return result;
}

function validateSaasResponse(response) {
  if (!isObject(response) || !Array.isArray(response.choices) || response.choices.length === 0) {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }

  const choice = response.choices[0];
  if (!isObject(choice) || !isObject(choice.message) || choice.message.role !== "assistant") {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }

  const content = choice.message.content ?? [];
  if (!Array.isArray(content)) {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }
  for (const block of content) {
    if (
      !isObject(block) ||
      block.type !== "text" ||
      typeof block.text !== "string" ||
      !block.text
    ) {
      fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
    }
  }

  const toolCalls = choice.message.tool_calls ?? [];
  if (!Array.isArray(toolCalls)) {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }
  const ids = new Set();
  for (const toolCall of toolCalls) {
    if (
      !isObject(toolCall) ||
      typeof toolCall.id !== "string" ||
      !toolCall.id.trim() ||
      ids.has(toolCall.id) ||
      toolCall.type !== "function" ||
      !isObject(toolCall.function) ||
      typeof toolCall.function.name !== "string" ||
      !toolCall.function.name.trim() ||
      typeof toolCall.function.arguments !== "string" ||
      !toolCall.function.arguments
    ) {
      fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
    }
    ids.add(toolCall.id);
  }
  if (content.length === 0 && toolCalls.length === 0) {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }
  if (toolCalls.length > 0 && choice.finish_reason !== "tool_calls") {
    fail("SCLAW_UPSTREAM_RESPONSE_INVALID");
  }

  return { choice, content, toolCalls };
}

export async function convertSaasResponse(response, sdk) {
  const { choice, content, toolCalls } = validateSaasResponse(response);
  const plaintextBlocks = [];

  for (const block of content) {
    let plaintext;
    try {
      plaintext = await sdk.decryptText(block.text);
    } catch {
      fail("SCLAW_DECRYPTION_FAILED");
    }
    if (typeof plaintext !== "string") {
      fail("SCLAW_DECRYPTION_FAILED");
    }
    plaintextBlocks.push(plaintext);
  }

  const plaintextToolCalls = [];
  for (const toolCall of toolCalls) {
    let argumentsText;
    try {
      argumentsText = await sdk.decryptText(toolCall.function.arguments);
    } catch {
      fail("SCLAW_DECRYPTION_FAILED");
    }
    if (typeof argumentsText !== "string") {
      fail("SCLAW_DECRYPTION_FAILED");
    }
    plaintextToolCalls.push({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.function.name,
        arguments: argumentsText,
      },
    });
  }

  const result = {
    id: response.id,
    object: response.object,
    created: response.created,
    model: response.model,
    choices: [
      {
        index: choice.index,
        message: {
          role: "assistant",
          content: plaintextBlocks.length > 0 ? plaintextBlocks.join("\n") : null,
          ...(plaintextToolCalls.length > 0
            ? { tool_calls: plaintextToolCalls }
            : {}),
        },
        finish_reason: choice.finish_reason,
      },
    ],
  };

  if (isObject(response.usage)) {
    result.usage = { ...response.usage };
  }

  return result;
}
