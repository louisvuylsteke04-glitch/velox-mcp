# Deploying Vēlox

Vēlox is a plain Next.js app on Vercel. There is no database, no environment variable and no secret to set.

## First deploy (once)

1. In Vercel, choose **Add New**, then **Project**, and import `louisvuylsteke04-glitch/velox-mcp`.
2. Keep every default (framework Next.js, build `next build`) and **Deploy**.
3. Open the deployment. The landing page shows the connector URL for that deployment, ending in `/api/mcp`.

From then on:

- Every pull request gets a **preview deployment** with its own URL. You can add it to Claude as a separate custom connector to try a change before it merges.
- Every merge to `main` updates **production**.

## Checking a deployment

- The landing page loads and shows the connector URL.
- In Claude, add the URL as a custom connector. The `velox_ping` tool answers with the engine version.
- Or, from a terminal, run the MCP Inspector against the URL:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: https://<your-deployment>/api/mcp
```

## Custom domain

Add a domain in the Vercel project's **Domains** settings. The connector URL follows it automatically.

## Running your own copy

Fork the repository and repeat the steps above. Under AGPL-3.0, if you run a modified copy as a service, you share your changes under the same licence.
