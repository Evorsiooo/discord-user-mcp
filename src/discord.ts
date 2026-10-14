// Minimal Discord REST client using plain fetch and a user token.

export const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "discord-user-mcp (https://github.com/evorsiooo/discord-user-mcp, 1.0.0)";
const MAX_RETRY_AFTER_SECONDS = 30;

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

// Shapes below are trimmed to the fields this server reads.
export interface User {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface Attachment {
  url: string;
  filename?: string;
}

export interface Message {
  id: string;
  channel_id: string;
  type?: number;
  author: User;
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  attachments?: Attachment[];
  embeds?: unknown[];
  message_reference?: { message_id?: string; channel_id?: string; type?: number };
  message_snapshots?: { message?: { content?: string; attachments?: Attachment[]; embeds?: unknown[] } }[];
}

export interface Guild {
  id: string;
  name: string;
}

export interface Channel {
  id: string;
  type: number;
  name?: string | null;
  parent_id?: string | null;
  position?: number;
  last_message_id?: string | null;
  recipients?: User[];
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DiscordClientOptions {
  token: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export class DiscordClient {
  private readonly token: string;
  private readonly fetchImpl: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DiscordClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * One request, retried at most once and only after an HTTP 429 (Discord did
   * not process it, so a retry cannot double-post). Network failures are never
   * retried: for a write, Discord may already have applied it.
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: this.token,
      "User-Agent": USER_AGENT,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    };

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), init);
      } catch {
        const write = method !== "GET";
        throw new DiscordError(
          `Network error reaching Discord (${method} ${path}).` +
            (write
              ? " The request may or may not have gone through and was NOT retried. Check the channel before trying again."
              : " Try again in a moment."),
        );
      }

      if (response.status === 429) {
        const body = await readBody(response);
        const retryAfter = retryAfterSeconds(response, body.json);
        if (attempt === 0 && retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
          await this.sleep(Math.ceil(retryAfter * 1000) + 100);
          continue;
        }
        const scope = isRecord(body.json) && body.json.global ? "global " : "";
        const wait = retryAfter !== undefined ? ` Retry after ${retryAfter.toFixed(1)}s.` : "";
        const edge = body.json === undefined ? ` Non-JSON response: ${snippet(body.text)}` : "";
        throw new DiscordError(`Rate limited by Discord (${scope}429) on ${method} ${path}.${wait}${edge}`, 429);
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const body = await readBody(response);
        if (body.json === undefined) {
          throw new DiscordError(`Discord returned an unreadable response (HTTP ${response.status}) on ${method} ${path}.`, response.status);
        }
        return body.json as T;
      }

      throw errorFor(method, path, response.status, await readBody(response));
    }
  }

  async listGuilds(): Promise<Guild[]> {
    // Paginated by id; 200 is the page maximum. Five pages is far above any account's guild cap.
    const guilds: Guild[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await this.request<Guild[]>("GET", "/users/@me/guilds", { query: { limit: 200, after } });
      guilds.push(...batch);
      if (batch.length < 200) break;
      after = batch[batch.length - 1]!.id;
    }
    return guilds;
  }

  listGuildChannels(guildId: string): Promise<Channel[]> {
    return this.request<Channel[]>("GET", `/guilds/${guildId}/channels`);
  }

  listDmChannels(): Promise<Channel[]> {
    return this.request<Channel[]>("GET", "/users/@me/channels");
  }

  listMessages(channelId: string, query: { limit: number; before?: string; around?: string }): Promise<Message[]> {
    return this.request<Message[]>("GET", `/channels/${channelId}/messages`, { query });
  }

  /**
   * Fetch one message. Discord has historically restricted the single-message
   * endpoint to bots, so if it is refused, fall back to the history endpoint
   * with `around`, which is what the official client uses.
   */
  async getMessage(channelId: string, messageId: string): Promise<Message> {
    try {
      return await this.request<Message>("GET", `/channels/${channelId}/messages/${messageId}`);
    } catch (error) {
      if (!(error instanceof DiscordError) || (error.status !== 401 && error.status !== 403)) throw error;
      const around = await this.listMessages(channelId, { limit: 1, around: messageId });
      const found = around.find((m) => m.id === messageId);
      if (!found) throw new DiscordError(`Message ${messageId} not found in channel ${channelId}.`, 404, 10008);
      return found;
    }
  }

  sendMessage(channelId: string, content: string, replyTo?: string): Promise<Message> {
    return this.request<Message>("POST", `/channels/${channelId}/messages`, {
      body: {
        content,
        // With enforce_nonce, Discord returns the existing message instead of
        // creating a duplicate if this exact request ever lands twice.
        nonce: makeNonce(),
        enforce_nonce: true,
        ...(replyTo && {
          message_reference: { message_id: replyTo, channel_id: channelId, fail_if_not_exists: true },
        }),
      },
    });
  }

  editMessage(channelId: string, messageId: string, content: string): Promise<Message> {
    return this.request<Message>("PATCH", `/channels/${channelId}/messages/${messageId}`, { body: { content } });
  }

  deleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.request<void>("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  addReaction(channelId: string, messageId: string, encodedEmoji: string): Promise<void> {
    return this.request<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`);
  }
}

interface Body {
  text: string;
  json: unknown;
}

async function readBody(response: Response): Promise<Body> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { text: "", json: undefined };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function retryAfterSeconds(response: Response, json: unknown): number | undefined {
  if (isRecord(json) && typeof json.retry_after === "number") return json.retry_after;
  const header = Number(response.headers.get("Retry-After"));
  return Number.isFinite(header) && header > 0 ? header : undefined;
}

function snippet(text: string, max = 300): string {
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain || "(empty body)";
}

function errorFor(method: string, path: string, status: number, body: Body): DiscordError {
  const where = `${method} ${path}`;
  const json = isRecord(body.json) ? body.json : undefined;
  if (!json) {
    return new DiscordError(
      `Discord returned HTTP ${status} with a non-JSON body on ${where}. This usually means the request was blocked before reaching the API. Body: ${snippet(body.text)}`,
      status,
    );
  }
  if ("captcha_key" in json || "captcha_sitekey" in json) {
    return new DiscordError(
      `Discord demanded a captcha on ${where} (HTTP ${status}). This server cannot and will not solve captchas. Stop and check the account in the Discord app.`,
      status,
    );
  }
  const code = typeof json.code === "number" ? json.code : undefined;
  const message = typeof json.message === "string" ? json.message : "no message";
  const detail = `Discord code ${code ?? "?"}: ${message}`;
  const fieldErrors = json.errors ? ` Field errors: ${snippet(JSON.stringify(json.errors), 400)}` : "";
  switch (status) {
    case 400:
      return new DiscordError(`Discord rejected the request on ${where} (400, ${detail}).${fieldErrors}`, status, code);
    case 401:
      return new DiscordError(
        `Discord rejected the token on ${where} (401, ${detail}). Either DISCORD_USER_TOKEN is wrong or expired, or Discord is refusing this request.`,
        status,
        code,
      );
    case 403:
      return new DiscordError(`No access on ${where} (403, ${detail}).`, status, code);
    case 404:
      return new DiscordError(`Not found on ${where} (404, ${detail}). Check the ids.`, status, code);
    default:
      return new DiscordError(`Discord error on ${where} (HTTP ${status}, ${detail}).${fieldErrors}`, status, code);
  }
}

const DISCORD_EPOCH = 1420070400000n;

/** A snowflake-shaped nonce for the current time, as Discord's own client sends. */
function makeNonce(): string {
  const random = BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! & 0x3fffff);
  return (((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | random).toString();
}
