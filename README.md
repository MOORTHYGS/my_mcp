# my_mcp

A small HTTP gateway for forwarding MCP requests to the upstream MCP server URL stored in Supabase PostgreSQL at `public.mcp."Cur_mcp_api"`.

## Request flow

1. A client sends a request to `https://<your-render-service>.onrender.com/mcp`.
2. The gateway reads the configured `Cur_mcp_api` from Supabase.
3. It appends the incoming `/mcp` path and forwards the method, query string, request headers, and raw body.
4. It streams the upstream response back with the upstream HTTP status and response headers.

The gateway does not implement MCP itself; it proxies HTTP requests to an existing HTTP-accessible MCP endpoint.

## Important security notes

- Rotate any database password that has been shared in chat, tickets, logs, or source control.
- Never commit `.env` or a real database password.
- Keep this repository private if it contains internal architecture details.
- Use a dedicated, least-privilege database role where possible. The gateway only needs `SELECT` on `public.mcp`.
- `Cur_mcp_api` should contain the upstream base URL, for example `https://your-upstream.example.com`. The gateway appends `/mcp`.
- The default configuration requires HTTPS for the upstream. `ALLOW_HTTP_UPSTREAM=true` should only be used for a trusted endpoint.
- `/health` verifies database connectivity. It does not reveal the upstream URL or database credentials.
- This service does not add authentication to the public `/mcp` endpoint. If your upstream is not already protected, add gateway authentication before exposing it publicly.

## Deploy to Render

1. Connect this private GitHub repository to a Render Web Service.
2. In Render, use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`
3. Add these environment variables in Render:
   - `DB_HOST`: your Supabase database host
   - `DB_PORT`: `5432`
   - `DB_NAME`: `postgres`
   - `DB_USER`: `postgres` (or preferably a dedicated least-privilege database user)
   - `DB_PASSWORD`: the newly rotated database password
   - `DB_SSL`: `true`
   - `ALLOW_HTTP_UPSTREAM`: `false`
4. Deploy. Render assigns a URL such as `https://my-mcp.onrender.com`.

## Test

```bash
curl -i https://YOUR-RENDER-HOST/health
curl -i https://YOUR-RENDER-HOST/mcp
```

The second request is forwarded to the upstream. An MCP endpoint may require a particular method, headers, or initialized session, so a simple GET can legitimately return a protocol-specific response.

## Configuration selection

By default, the gateway selects the row with the highest `id` whose `Cur_mcp_api` is non-empty. To use a specific row instead, set `UPSTREAM_ROW_ID` to that row's numeric ID in Render.

## Limitations

- The upstream must be reachable from Render over HTTP(S).
- The proxy forwards the incoming `/mcp` path and query string; if `Cur_mcp_api` already ends in `/mcp`, the resulting path would be `/mcp/mcp`. Store the base URL without the `/mcp` suffix.
- Supabase connection pooling or the direct database endpoint may be needed if direct PostgreSQL connectivity is unavailable in your deployment environment.
