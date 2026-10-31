import express from "express";
import pg from "pg";
import net from "node:net";

const { Pool } = pg;
const app = express();

const PORT = Number(process.env.PORT || 3000);
const DB_SSL = String(process.env.DB_SSL ?? "true").toLowerCase() === "true";
const ALLOW_HTTP_UPSTREAM =
  String(process.env.ALLOW_HTTP_UPSTREAM ?? "false").toLowerCase() === "true";
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 120000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
const UPSTREAM_ROW_ID = process.env.UPSTREAM_ROW_ID
  ? Number(process.env.UPSTREAM_ROW_ID)
  : null;

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD) {
  console.warn("Database environment variables are incomplete. Set DB_HOST, DB_USER, and DB_PASSWORD.");
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "postgres",
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: DB_SSL ? { rejectUnauthorized: true } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5
});

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function validateUpstreamUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("The configured upstream URL is invalid.");
  }

  if (url.protocol !== "https:" && !(ALLOW_HTTP_UPSTREAM && url.protocol === "http:")) {
    throw new Error("The upstream URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Credentials must not be embedded in the upstream URL.");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("Local upstream hosts are not allowed.");
  }
  if (net.isIP(url.hostname) === 4 && isPrivateIpv4(url.hostname)) {
    throw new Error("Private or reserved IPv4 upstream addresses are not allowed.");
  }
  if (url.hostname === "::1" || url.hostname.startsWith("fc") || url.hostname.startsWith("fd") || url.hostname.startsWith("fe80:")) {
    throw new Error("Private IPv6 upstream addresses are not allowed.");
  }

  // Store the base URL without /mcp. Keep any configured base path, if present.
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

async function getUpstreamBaseUrl() {
  let result;
  if (Number.isSafeInteger(UPSTREAM_ROW_ID) && UPSTREAM_ROW_ID > 0) {
    result = await pool.query(
      'SELECT "Cur_mcp_api" FROM public.mcp WHERE id = $1 AND NULLIF(BTRIM("Cur_mcp_api"), \'\') IS NOT NULL LIMIT 1',
      [UPSTREAM_ROW_ID]
    );
  } else {
    result = await pool.query(
      'SELECT "Cur_mcp_api" FROM public.mcp WHERE NULLIF(BTRIM("Cur_mcp_api"), \'\') IS NOT NULL ORDER BY id DESC LIMIT 1'
    );
  }

  const rawUrl = result.rows[0]?.Cur_mcp_api;
  if (!rawUrl) throw new Error("No non-empty Cur_mcp_api URL was found in public.mcp.");
  return validateUpstreamUrl(String(rawUrl));
}

app.disable("x-powered-by");
app.get("/", (_req, res) => {
  res.json({
    service: "my_mcp",
    status: "running",
    endpoints: { health: "/health", mcp: "/mcp" }
  });
});

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Health check database failure:", error.message);
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

// Capture the body as raw bytes so JSON, protocol payloads, and other content types
// are forwarded without re-serializing the request.
app.use("/mcp", express.raw({
  type: () => true,
  limit: MAX_BODY_BYTES,
  inflate: false
}));

app.all("/mcp", async (req, res) => {
  let timeout;
  try {
    const baseUrl = await getUpstreamBaseUrl();
    const upstreamUrl = new URL(baseUrl.toString());
    upstreamUrl.pathname = `${upstreamUrl.pathname}/mcp`.replace(/\/{2,}/g, "/");
    upstreamUrl.search = new URL(req.originalUrl, "http://gateway.invalid").search;

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || value === null) continue;
      const lower = name.toLowerCase();
      if ([
        "host", "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "te", "trailer", "transfer-encoding",
        "upgrade", "content-length", "accept-encoding"
      ].includes(lower)) continue;
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else {
        headers.set(name, value);
      }
    }

    timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const controller = new AbortController();
    // Timer is assigned before fetch; abort is handled by the catch below.
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
      signal: controller.signal,
      duplex: "half"
    });

    res.status(upstreamResponse.status);
    upstreamResponse.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if ([
        "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "te", "trailer", "transfer-encoding",
        "upgrade", "content-encoding", "content-length"
      ].includes(lower)) return;
      res.setHeader(name, value);
    });

    if (req.method === "HEAD" || upstreamResponse.status === 204 || upstreamResponse.status === 304) {
      res.end();
      return;
    }

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    const reader = upstreamResponse.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error("MCP proxy request failed:", error.message);
    if (!res.headersSent) {
      const isTimeout = error.name === "AbortError";
      res.status(isTimeout ? 504 : 502).json({
        error: isTimeout ? "Upstream request timed out." : "MCP upstream request failed."
      });
    } else {
      res.destroy(error);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large." });
  }
  console.error("Request handling error:", error.message);
  if (!res.headersSent) res.status(400).json({ error: "Invalid request." });
});

const server = app.listen(PORT, () => {
  console.log(`my_mcp gateway listening on port ${PORT}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
