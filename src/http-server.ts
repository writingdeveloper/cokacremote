import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { createOAuthMetadata, mcpAuthRouter } from "@modelcontextprotocol/server-legacy/auth";
import type { AuthRouterOptions } from "@modelcontextprotocol/server-legacy/auth";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import express, { type Request, type Response } from "express";

import { createBearerAuth, createHostValidation } from "./auth.js";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMcpServer, type McpServices } from "./mcp-server.js";
import { OAUTH_SCOPES, RemoteDevOAuthProvider } from "./oauth.js";

export interface RunningHttpServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
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
): Promise<RunningHttpServer> {
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
    const startedAt = performance.now();
    let logged = false;
    response.set("X-Request-Id", requestId);
    const logCompletion = (outcome: "completed" | "aborted") => {
      if (logged) {
        return;
      }
      logged = true;
      console.log(
        JSON.stringify({
          event: "mcp_request",
          requestId,
          httpMethod: request.method,
          rpcMethod: rpcMethod(request.body),
          toolName: rpcToolName(request.body),
          status: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
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

  let activeMcpRequests = 0;
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
    app.use(mcpAuthRouter(oauthRouterOptions));
  }
  const authenticate = createBearerAuth(config, oauthProvider);
  const parseMcpJson = express.json({ limit: config.maxRequestBody });

  app.get("/health", (_request, response) => {
    const processes = services.processManager.stats();
    response.json({
      status: "ok",
      service: "cokacremote",
      version: "0.1.0",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests,
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
        console.error("MCP handler error:", errorMessage(error));
      },
    },
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      console.error("MCP Node adapter error:", errorMessage(error));
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
        console.error("Legacy MCP transport error:", errorMessage(error));
      };
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      await server.close().catch((error) => {
        console.error("Failed to close legacy MCP request:", errorMessage(error));
      });
    }
  };

  const postHandler = async (request: Request, response: Response): Promise<void> => {
    activeMcpRequests += 1;
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      activeMcpRequests = Math.max(0, activeMcpRequests - 1);
    };
    response.once("finish", () => void closeRequest());
    response.once("close", () => void closeRequest());
    try {
      const webRequest = await toWebRequest(request, request.body);
      if (await isLegacyRequest(webRequest, request.body)) {
        await handleLegacyRequest(request, response);
      } else {
        await nodeMcpHandler(request, response, request.body);
      }
    } catch (error) {
      console.error("MCP POST failed:", errorMessage(error));
      if (!response.headersSent) {
        rpcError(response, 500, "Internal MCP server error");
      }
      await closeRequest();
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

  const close = async (): Promise<void> => {
    clearInterval(cleanupInterval);
    activeMcpRequests = 0;
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
  };

  return { httpServer, close };
}
