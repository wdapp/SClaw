import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import {
  JinghuaBridgeError,
  convertOpenAiRequest,
  convertSaasResponse,
} from "./protocol.mjs";

const bundledSdkUrl = new URL("./vendor/client-tssdk/index.js", import.meta.url);
const sourceSdkUrl = new URL("../vendor/client-tssdk/index.js", import.meta.url);
const sdkUrl = existsSync(fileURLToPath(bundledSdkUrl))
  ? bundledSdkUrl
  : sourceSdkUrl;
const { ClientTSSDK, SDK_VERSION } = await import(sdkUrl.href);

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3190;
const DEFAULT_UPSTREAM = "https://api-test.jinghua.security";
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

function normalizeUpstreamBaseUrl(value) {
  const url = new URL(value);
  return url.href.replace(/\/$/, "");
}

function bridgeError(code) {
  return new JinghuaBridgeError(code);
}

function sendJson(response, status, body, requestId) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-request-id": requestId,
  });
  response.end(payload);
}

function requireBearerAuthorization(request) {
  const authorization = request.headers.authorization;
  if (
    typeof authorization !== "string" ||
    !/^Bearer\s+\S+$/i.test(authorization)
  ) {
    throw bridgeError("SCLAW_AUTH_REQUIRED");
  }
  return authorization;
}

function requireJsonContentType(request) {
  const contentType = request.headers["content-type"];
  const mediaType = typeof contentType === "string"
    ? contentType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (mediaType !== "application/json") {
    throw bridgeError("SCLAW_CONTENT_TYPE_UNSUPPORTED");
  }
}

async function readJsonBody(request, limitBytes) {
  const contentLength = request.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    Number.parseInt(contentLength, 10) > limitBytes
  ) {
    request.resume();
    throw bridgeError("SCLAW_BODY_TOO_LARGE");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      throw bridgeError("SCLAW_BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw bridgeError("SCLAW_REQUEST_INVALID");
  }
}

async function readUpstreamJson(response, signal) {
  try {
    return await response.json();
  } catch {
    if (signal.aborted) {
      throw bridgeError("SCLAW_UPSTREAM_TIMEOUT");
    }
    throw bridgeError("SCLAW_UPSTREAM_JSON_INVALID");
  }
}

function createUpstreamFetcher({ fetchImpl, timeoutMs, activeControllers }) {
  return async function fetchUpstream(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    activeControllers.add(controller);

    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
      const body = await readUpstreamJson(response, controller.signal);
      return { response, body };
    } catch (error) {
      if (error instanceof JinghuaBridgeError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw bridgeError("SCLAW_UPSTREAM_TIMEOUT");
      }
      throw bridgeError("SCLAW_UPSTREAM_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      activeControllers.delete(controller);
    }
  };
}

function writeRequestLog(logger, entry) {
  logger({
    requestId: entry.requestId,
    status: entry.status,
    durationMs: entry.durationMs,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.toolsEnabled !== undefined
      ? { toolsEnabled: entry.toolsEnabled }
      : {}),
    ...(entry.toolCount !== undefined ? { toolCount: entry.toolCount } : {}),
    ...(entry.toolCallCount !== undefined
      ? { toolCallCount: entry.toolCallCount }
      : {}),
    ...(entry.finishReason ? { finishReason: entry.finishReason } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
  });
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

export async function startSidecar({
  ClientTSSDKClass = ClientTSSDK,
  upstreamBaseUrl = DEFAULT_UPSTREAM,
  fetchImpl = globalThis.fetch,
  port = DEFAULT_PORT,
  bodyLimitBytes = DEFAULT_BODY_LIMIT_BYTES,
  upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  logger = (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const normalizedUpstream = normalizeUpstreamBaseUrl(upstreamBaseUrl);
  const sdk = new ClientTSSDKClass({
    appName: "sclaw-node-sidecar",
    apiBaseUrl: normalizedUpstream,
  });

  try {
    await sdk.init();
    await sdk.envInit();
  } catch (error) {
    sdk.destroy();
    throw error;
  }

  const activeControllers = new Set();
  const fetchUpstream = createUpstreamFetcher({
    fetchImpl,
    timeoutMs: upstreamTimeoutMs,
    activeControllers,
  });

  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let model;
    let status = 500;
    let errorCode;
    let toolsEnabled;
    let toolCount;
    let toolCallCount;
    let finishReason;

    try {
      const url = new URL(request.url ?? "/", `http://${HOST}`);

      if (request.method === "GET" && url.pathname === "/health") {
        status = 200;
        sendJson(response, status, {
          status: "ok",
          sdkVersion: sdk.version ?? SDK_VERSION,
          upstream: normalizedUpstream,
        }, requestId);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const authorization = requireBearerAuthorization(request);
        const { response: upstreamResponse, body } = await fetchUpstream(
          `${normalizedUpstream}/v1/models`,
          {
            method: "GET",
            headers: { authorization },
          },
        );
        status = upstreamResponse.status;
        sendJson(response, status, body, requestId);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const authorization = requireBearerAuthorization(request);
        requireJsonContentType(request);
        const body = await readJsonBody(request, bodyLimitBytes);
        model = typeof body?.model === "string" ? body.model : undefined;
        const upstreamBody = await convertOpenAiRequest(body, sdk);
        toolsEnabled = Array.isArray(upstreamBody.tools) && upstreamBody.tools.length > 0;
        toolCount = upstreamBody.tools?.length ?? 0;
        toolCallCount = upstreamBody.messages.reduce(
          (count, message) => count + (message.tool_calls?.length ?? 0),
          0,
        );
        const { response: upstreamResponse, body: upstreamJson } = await fetchUpstream(
          `${normalizedUpstream}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization,
              "content-type": "application/json",
            },
            body: JSON.stringify(upstreamBody),
          },
        );
        status = upstreamResponse.status;
        if (!upstreamResponse.ok) {
          sendJson(response, status, upstreamJson, requestId);
          return;
        }
        const result = await convertSaasResponse(upstreamJson, sdk);
        const resultChoice = result.choices?.[0];
        toolCallCount = (resultChoice?.message?.tool_calls ?? []).length;
        finishReason = resultChoice?.finish_reason;
        sendJson(response, status, result, requestId);
        return;
      }

      status = 404;
      sendJson(response, status, {
        error: {
          type: "jinghua_bridge_error",
          code: "SCLAW_ROUTE_NOT_FOUND",
          message: "未找到请求的 sidecar 路由",
        },
      }, requestId);
    } catch (error) {
      const safeError = error instanceof JinghuaBridgeError
        ? error
        : bridgeError("SCLAW_UPSTREAM_UNAVAILABLE");
      status = safeError.status;
      errorCode = safeError.code;
      if (!response.headersSent) {
        sendJson(response, status, safeError.toJSON(), requestId);
      } else {
        response.destroy();
      }
    } finally {
      writeRequestLog(logger, {
        requestId,
        status,
        durationMs: Date.now() - startedAt,
        model,
        toolsEnabled,
        toolCount,
        toolCallCount,
        finishReason,
        errorCode,
      });
    }
  });

  try {
    await listen(server, port);
  } catch (error) {
    sdk.destroy();
    throw error;
  }

  let shutdownPromise;
  const shutdown = () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = new Promise((resolveShutdown) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        sdk.destroy();
        resolveShutdown();
      };
      const timeout = setTimeout(() => {
        for (const controller of activeControllers) {
          controller.abort();
        }
        server.closeAllConnections?.();
        finish();
      }, shutdownTimeoutMs);
      timeout.unref?.();
      server.close(() => {
        clearTimeout(timeout);
        finish();
      });
      server.closeIdleConnections?.();
    });
    return shutdownPromise;
  };

  const address = server.address();
  if (!address || typeof address === "string") {
    await shutdown();
    throw new Error("Sidecar did not expose a TCP address");
  }

  return {
    host: HOST,
    port: address.port,
    sdkVersion: sdk.version ?? SDK_VERSION,
    upstream: normalizedUpstream,
    shutdown,
  };
}

export function installProcessShutdown(sidecar, {
  input = process.stdin,
  processObject = process,
} = {}) {
  let stopping = false;

  const cleanup = () => {
    input.off("end", requestShutdown);
    input.off("close", requestShutdown);
    processObject.off("SIGTERM", requestShutdown);
    processObject.off("SIGINT", requestShutdown);
  };
  const requestShutdown = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    cleanup();
    void sidecar.shutdown().then(
      () => {
        input.pause?.();
      },
      () => {
        processObject.exitCode = 1;
        input.pause?.();
      },
    );
  };

  input.once("end", requestShutdown);
  input.once("close", requestShutdown);
  processObject.once("SIGTERM", requestShutdown);
  processObject.once("SIGINT", requestShutdown);
  input.resume?.();

  return cleanup;
}

async function runCli() {
  let sidecar;
  try {
    sidecar = await startSidecar();
    installProcessShutdown(sidecar);
    process.stdout.write(
      `SCLAW_SIDECAR_READY ${JSON.stringify({
        port: sidecar.port,
        sdkVersion: sidecar.sdkVersion,
      })}\n`,
    );
  } catch {
    await sidecar?.shutdown();
    process.stderr.write(
      `${JSON.stringify({
        errorCode: "SCLAW_SIDECAR_START_FAILED",
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli();
}
