import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/server-legacy/auth";
import type { AuthRouterOptions } from "@modelcontextprotocol/server-legacy/auth";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";

import { createBearerAuth, createHostValidation } from "./auth.js";
import { BusyError, ConcurrencyGate } from "./concurrency-gate.js";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { CimdClientResolver, isCimdClientId, type CimdClientResolverLike } from "./cimd.js";
import { createMcpServer, REGISTERED_TOOL_COUNT, type McpServices } from "./mcp-server.js";
import { OAUTH_SCOPES, RemoteDevOAuthProvider } from "./oauth.js";

export interface RunningHttpServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

export interface HttpServerOptions {
  cimdResolver?: CimdClientResolverLike;
}

function rpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function rpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function rpcToolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export async function startHttpServer(
  config: AppConfig,
  services: McpServices,
  options: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const serverInstanceId = randomUUID();
  const startedAt = new Date().toISOString();
  let lastMcpRequestAt: string | undefined;
  let mcpRequestCount = 0;
  let mcpAbortedRequestCount = 0;
  let mcpErrorResponseCount = 0;
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }
  app.use((request, response, next) => {
    if (request.path !== config.endpoint) {
      next();
      return;
    }
    const requestId = randomUUID();
    const requestStartedAt = performance.now();
    const requestAt = new Date().toISOString();
    lastMcpRequestAt = requestAt;
    mcpRequestCount += 1;
    let logged = false;
    response.set("X-Request-Id", requestId);
    const logCompletion = (outcome: "completed" | "aborted") => {
      if (logged) {
        return;
      }
      logged = true;
      if (outcome === "aborted") {
        mcpAbortedRequestCount += 1;
      }
      if (response.statusCode >= 400) {
        mcpErrorResponseCount += 1;
      }
      console.log(
        JSON.stringify({
          event: "mcp_request",
          serverInstanceId,
          processId: process.pid,
          requestId,
          requestAt,
          httpMethod: request.method,
          rpcMethod: rpcMethod(request.body),
          toolName: rpcToolName(request.body),
          protocolVersion: request.header("mcp-protocol-version") ?? undefined,
          sessionId: request.header("mcp-session-id") ?? undefined,
          status: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - requestStartedAt) * 10) / 10,
        }),
      );
    };
    response.once("finish", () => logCompletion("completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        logCompletion("aborted");
      }
    });
    next();
  });
  app.use(createHostValidation(config));

  const requestGate = new ConcurrencyGate(
    config.maxConcurrentToolCalls,
    config.maxQueuedRequests,
  );
  const oauthProvider = config.oauthEnabled ? new RemoteDevOAuthProvider(config) : undefined;
  if (oauthProvider) {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.set("Access-Control-Allow-Origin", "*").json({
        resource: oauthProvider.resourceUrl.href,
        authorization_servers: [oauthProvider.issuerUrl.href],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "cokacremote",
      });
    });
    const oauthRouterOptions = {
      provider: oauthProvider,
      issuerUrl: oauthProvider.issuerUrl,
      resourceServerUrl: oauthProvider.resourceUrl,
      scopesSupported: [...OAUTH_SCOPES],
      resourceName: "cokacremote",
    } satisfies AuthRouterOptions;
    const oauthMetadata = {
      ...createOAuthMetadata(oauthRouterOptions),
      revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      ...(config.oauthCimdEnabled ? { client_id_metadata_document_supported: true } : {}),
    };
    const issuerPath = oauthProvider.issuerUrl.pathname.replace(/\/$/, "");
    const oauthMetadataPath = `/.well-known/oauth-authorization-server${issuerPath}`;
    app.use((request, response, next) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.path === oauthMetadataPath
      ) {
        response.set("Access-Control-Allow-Origin", "*").json(oauthMetadata);
        return;
      }
      next();
    });
    if (config.oauthCimdEnabled) {
      const cimdResolver = options.cimdResolver ?? new CimdClientResolver();
      const cimdForm = express.urlencoded({ extended: false });
      app.all("/authorize", cimdForm, (request, response, next) => {
        const values = request.method === "POST" ? request.body : request.query;
        const clientId = typeof values?.client_id === "string" ? values.client_id : undefined;
        if (!clientId || !isCimdClientId(clientId)) {
          next();
          return;
        }
        void (async () => {
          const redirectUri =
            typeof values.redirect_uri === "string" ? values.redirect_uri : undefined;
          const responseType =
            typeof values.response_type === "string" ? values.response_type : undefined;
          const codeChallenge =
            typeof values.code_challenge === "string" ? values.code_challenge : undefined;
          const codeChallengeMethod =
            typeof values.code_challenge_method === "string"
              ? values.code_challenge_method
              : undefined;
          const scope = typeof values.scope === "string" ? values.scope : undefined;
          const state = typeof values.state === "string" ? values.state : undefined;
          const resource = typeof values.resource === "string" ? values.resource : undefined;
          if (
            !redirectUri ||
            !URL.canParse(redirectUri) ||
            responseType !== "code" ||
            !codeChallenge ||
            codeChallengeMethod !== "S256"
          ) {
            response.status(400).json({
              error: "invalid_request",
              error_description: "Invalid CIMD authorization request",
            });
            return;
          }
          let resourceUrl: URL | undefined;
          if (resource !== undefined) {
            if (!URL.canParse(resource)) {
              response.status(400).json({
                error: "invalid_request",
                error_description: "Invalid resource URL",
              });
              return;
            }
            resourceUrl = new URL(resource);
          }
          try {
            await oauthProvider.authorizeCimd(
              clientId,
              {
                state,
                scopes: scope ? scope.split(" ").filter(Boolean) : [],
                redirectUri,
                codeChallenge,
                resource: resourceUrl,
                issuer: oauthProvider.issuerUrl.href,
              },
              response,
              cimdResolver,
            );
          } catch (error) {
            if (!response.headersSent) {
              response.status(400).json({
                error: "invalid_client_metadata",
                error_description: errorMessage(error),
              });
            }
          }
        })();
      });
    }
    app.use(mcpAuthRouter(oauthRouterOptions));
  }
  const authenticate = createBearerAuth(config, oauthProvider);
  const parseMcpJson = express.json({ limit: config.maxRequestBody });

  app.get("/health", (_request, response) => {
    const processes = services.processManager.stats();
    const concurrency = requestGate.stats();
    response.json({
      status: "ok",
      service: "cokacremote",
      version: "0.1.0",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests: concurrency.active,
      queuedMcpRequests: concurrency.queued,
      serverInstanceId,
      processId: process.pid,
      startedAt,
      lastMcpRequestAt,
      mcpRequestCount,
      mcpAbortedRequestCount,
      mcpErrorResponseCount,
      registeredToolCount: REGISTERED_TOOL_COUNT,
      concurrency,
      managedProcesses: processes.running + processes.completedRetained,
      processes,
      unrestrictedHostAccess: true,
      oauthEnabled: config.oauthEnabled,
    });
  });

  const mcpHandler = createMcpHandler(
    () => createMcpServer(config, services),
    {
      legacy: "reject",
      responseMode: "json",
      onerror: (error) => {
        console.error("MCP handler error:", error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
      },
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      console.error("MCP Node adapter error:", error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
    },
  });

  const handleLegacyRequest = async (request: Request, response: Response): Promise<void> => {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(config, services);
    try {
      transport.onerror = (error) => {
        console.error("Legacy MCP transport error:", error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close().catch((error) => {
        console.error("Failed to close legacy MCP request:", error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
      });
    }
  };

  const postHandler = async (request: Request, response: Response): Promise<void> => {
    try {
      await requestGate.run(async () => {
        const webRequest = await toWebRequest(request, request.body);
        if (await isLegacyRequest(webRequest, request.body)) {
          await handleLegacyRequest(request, response);
        } else {
          await nodeMcpHandler(request, response, request.body);
        }
      });
    } catch (error) {
      if (error instanceof BusyError) {
        if (!response.headersSent) {
          response.set("Retry-After", "1");
          rpcError(response, 429, error.message);
        }
        return;
      }
      console.error("MCP POST failed:", error instanceof Error ? (error.stack ?? error.message) : errorMessage(error));
      if (!response.headersSent) {
        rpcError(response, 500, "Internal MCP server error");
      }
    }
  };

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.set("Allow", "POST");
    rpcError(response, 405, "Stateless MCP accepts POST requests only");
  };

  app.post(
    config.endpoint,
    authenticate,
    parseMcpJson,
    (request, response) => {
      void postHandler(request, response);
    },
  );
  app.get(config.endpoint, authenticate, methodNotAllowed);
  app.delete(config.endpoint, authenticate, methodNotAllowed);

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      if (!response.headersSent) {
        rpcError(response, 400, `Invalid request body: ${errorMessage(error)}`);
      }
    },
  );

  const cleanupInterval = setInterval(() => {
    services.processManager.prune();
  }, Math.min(config.processRetentionMs, 60_000));
  cleanupInterval.unref();

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listeningServer = app.listen(config.port, config.host, () => resolve(listeningServer));
    listeningServer.once("error", reject);
  });

  console.log(JSON.stringify({ event: "server_lifecycle", phase: "started", serverInstanceId, processId: process.pid, startedAt, registeredToolCount: REGISTERED_TOOL_COUNT }));
  const heartbeatInterval = setInterval(() => {
    const concurrency = requestGate.stats();
    const processes = services.processManager.stats();
    console.log(JSON.stringify({ event: "server_heartbeat", serverInstanceId, processId: process.pid, startedAt, at: new Date().toISOString(), lastMcpRequestAt, mcpRequestCount, mcpAbortedRequestCount, mcpErrorResponseCount, activeMcpRequests: concurrency.active, queuedMcpRequests: concurrency.queued, managedProcesses: processes.running + processes.completedRetained, runningProcesses: processes.running }));
  }, 60_000);
  heartbeatInterval.unref();

  const close = async (): Promise<void> => {
    clearInterval(cleanupInterval);
    clearInterval(heartbeatInterval);
    console.log(JSON.stringify({ event: "server_lifecycle", phase: "stopping", serverInstanceId, processId: process.pid, at: new Date().toISOString() }));
    await mcpHandler.close();
    await services.processManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.log(JSON.stringify({ event: "server_lifecycle", phase: "stopped", serverInstanceId, processId: process.pid, at: new Date().toISOString() }));
  };

  return { httpServer, close };
}
