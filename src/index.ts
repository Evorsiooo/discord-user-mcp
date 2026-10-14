import { createMcpHandler } from "agents/mcp/server";
import { isAuthorized } from "./auth";
import { DiscordClient } from "./discord";
import { createServer } from "./tools";

export interface Env {
  DISCORD_USER_TOKEN: string;
  SERVER_SECRET: string;
}

const ROUTE = "/mcp";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname !== ROUTE) return new Response(null, { status: 404 });
    if (!(await isAuthorized(request, env.SERVER_SECRET))) return new Response(null, { status: 401 });
    if (!env.DISCORD_USER_TOKEN) return new Response("DISCORD_USER_TOKEN is not set.", { status: 500 });

    const discord = new DiscordClient({ token: env.DISCORD_USER_TOKEN });
    // corsOptions: false sends no Access-Control-* headers: only Claude's cloud calls this, never a browser.
    const handler = createMcpHandler(() => createServer(discord), { route: ROUTE, corsOptions: false });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
