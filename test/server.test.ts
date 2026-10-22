import { describe, expect, it } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { DiscordClient, type Message } from "../src/discord";
import { checkTextStart, encodeEmoji } from "../src/format";
import { createServer } from "../src/tools";

const CHANNEL = "111111111111111111";
const MESSAGE = "222222222222222222";

const message: Message = {
  id: MESSAGE,
  channel_id: CHANNEL,
  type: 0,
  author: { id: "333333333333333333", username: "alice", global_name: "Alice A" },
  content: "Hello there, this is the original message text that is fairly long.",
  timestamp: "2026-10-14T12:00:00.000000+00:00",
};

interface Call {
  method: string;
  url: string;
  body?: string;
}

type Responder = (call: Call) => Response | Promise<Response>;

function fakeDiscord(responder: Responder) {
  const calls: Call[] = [];
  const client = new DiscordClient({
    token: "test-token",
    sleep: async () => {},
    fetch: async (url, init) => {
      const call = { method: init?.method ?? "GET", url, body: init?.body as string | undefined };
      calls.push(call);
      return responder(call);
    },
  });
  return { client, calls };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

async function callTool(client: DiscordClient, name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(() => createServer(client), { corsOptions: false });
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { Host: "localhost", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const response = await handler.fetch(request);
  const raw = await response.text();
  const data = raw.split("\n").find((line) => line.startsWith("data: "));
  const parsed = JSON.parse(data ? data.slice(6) : raw);
  return parsed.result as { content: { text: string }[]; isError?: boolean };
}

describe("delete_message", () => {
  it("refuses when the text does not match and never sends DELETE", async () => {
    const { client, calls } = fakeDiscord(() => json(message));
    const result = await callTool(client, "delete_message", {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      expected_author: "alice",
      expected_text_start: "Something else entirely here",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("does not match");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses when the author does not match", async () => {
    const { client, calls } = fakeDiscord(() => json(message));
    const result = await callTool(client, "delete_message", {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      expected_author: "bob",
      expected_text_start: "Hello there, this is the original",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("expected_author does not match");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes when author (display name) and text match", async () => {
    const { client, calls } = fakeDiscord((c) => (c.method === "DELETE" ? new Response(null, { status: 204 }) : json(message)));
    const result = await callTool(client, "delete_message", {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      expected_author: "@Alice A",
      expected_text_start: "Hello there,  this is the original…",
    });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });
});

describe("edit_message", () => {
  it("refuses on mismatch without sending PATCH", async () => {
    const { client, calls } = fakeDiscord(() => json(message));
    const result = await callTool(client, "edit_message", {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      expected_old_text_start: "Goodbye, this is not it at all",
      content: "new text",
    });
    expect(result.isError).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("edits on match", async () => {
    const { client, calls } = fakeDiscord((c) => json(c.method === "PATCH" ? { ...message, content: "new text" } : message));
    const result = await callTool(client, "edit_message", {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      expected_old_text_start: "Hello there, this is the original message",
      content: "new text",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(calls[1]!.body!)).toEqual({ content: "new text" });
  });
});

describe("get_message", () => {
  it("falls back to the history endpoint when the single-message endpoint is refused", async () => {
    const { client, calls } = fakeDiscord((c) =>
      c.url.includes("around=") ? json([message]) : json({ code: 20002, message: "Only bots can use this endpoint" }, 403),
    );
    const result = await callTool(client, "get_message", { channel_id: CHANNEL, message_id: MESSAGE });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).author.username).toBe("alice");
    expect(calls[1]!.url).toContain(`around=${MESSAGE}`);
  });
});

describe("read_messages", () => {
  it("returns oldest first and truncates long content", async () => {
    const newer = { ...message, id: "222222222222222223", content: "x".repeat(5000) };
    const { client, calls } = fakeDiscord(() => json([newer, message]));
    const result = await callTool(client, "read_messages", { channel_id: CHANNEL });
    const lines = result.content[0]!.text.split("\n").slice(1).map((l) => JSON.parse(l));
    expect(lines.map((m) => m.id)).toEqual([MESSAGE, "222222222222222223"]);
    expect(lines[1].content.length).toBeLessThan(800);
    expect(calls[0]!.url).toContain("limit=25");
  });
});

describe("request handling", () => {
  it("retries once after a 429 and then succeeds", async () => {
    let n = 0;
    const { client, calls } = fakeDiscord(() => (n++ === 0 ? json({ message: "rate", retry_after: 0.5, global: false }, 429) : json([])));
    const result = await callTool(client, "list_guilds", {});
    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(2);
  });

  it("gives up after a second 429", async () => {
    const { client, calls } = fakeDiscord(() => json({ message: "rate", retry_after: 1.5 }, 429));
    const result = await callTool(client, "list_guilds", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Rate limited");
    expect(calls.length).toBe(2);
  });

  it("never retries a send after a network failure", async () => {
    const { client, calls } = fakeDiscord(() => {
      throw new TypeError("network down");
    });
    const result = await callTool(client, "send_message", { channel_id: CHANNEL, content: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("NOT retried");
    expect(calls.length).toBe(1);
  });

  it("sends the raw token, a reply reference and a nonce", async () => {
    const { client, calls } = fakeDiscord(() => json(message));
    await callTool(client, "send_message", { channel_id: CHANNEL, content: "hi", reply_to: MESSAGE });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.message_reference.message_id).toBe(MESSAGE);
    expect(body.enforce_nonce).toBe(true);
    expect(body.allowed_mentions).toBeUndefined();
  });

  it("reports captcha and non-JSON blocks clearly", async () => {
    const captcha = fakeDiscord(() => json({ captcha_key: ["captcha-required"], captcha_sitekey: "x" }, 400));
    expect((await callTool(captcha.client, "list_guilds", {})).content[0]!.text).toContain("captcha");
    const blocked = fakeDiscord(() => new Response("<html><h1>Access denied</h1> Error 1020</html>", { status: 403 }));
    expect((await callTool(blocked.client, "list_guilds", {})).content[0]!.text).toContain("non-JSON");
  });
});

describe("helpers", () => {
  it("encodes emoji", () => {
    expect(encodeEmoji("👍")).toBe("%F0%9F%91%8D");
    expect(encodeEmoji("blobcat:123456789012345678")).toBe("blobcat%3A123456789012345678");
    expect(encodeEmoji("<a:blobcat:123456789012345678>")).toBe("blobcat%3A123456789012345678");
    expect(() => encodeEmoji(":thumbsup:")).toThrow(/shortcode/);
    expect(() => encodeEmoji("abc")).toThrow(/not an emoji/);
  });

  it("requires a meaningful prefix", () => {
    expect(checkTextStart("Hello there friend, how are you", "H", "x")).toMatch(/at least/);
    expect(checkTextStart("short", "short", "x")).toBeNull();
    expect(checkTextStart("", "", "x")).toBeNull();
  });
});

const FORUM = "444444444444444444";
const THREAD = "555555555555555555";
const CDN = "https://cdn.discordapp.com/attachments/111111111111111111/666666666666666666/memo.png?ex=1&is=2&hm=3&";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const imageResponse = (bytes: Uint8Array, type = "image/png") =>
  new Response(bytes, { headers: { "Content-Type": type, "Content-Length": String(bytes.length) } });

describe("forum channels", () => {
  it("lists forum and media channels in list_channels", async () => {
    const { client } = fakeDiscord(() =>
      json([
        { id: "1", type: 0, name: "chat", position: 0 },
        { id: FORUM, type: 15, name: "help-posts", position: 1 },
        { id: "2", type: 16, name: "art", position: 2 },
        { id: "3", type: 2, name: "voice", position: 3 },
      ]),
    );
    const rows = JSON.parse((await callTool(client, "list_channels", { guild_id: CHANNEL })).content[0]!.text);
    expect(rows.map((r: { type: string }) => r.type)).toEqual(["text", "forum", "media"]);
  });

  it("lists posts with tag names and a first-post preview", async () => {
    const { client, calls } = fakeDiscord((c) =>
      c.url.includes("/threads/search")
        ? json({
            threads: [
              {
                id: THREAD,
                type: 11,
                name: "How do I deploy?",
                parent_id: FORUM,
                applied_tags: ["t1"],
                message_count: 4,
                last_message_id: "1562644070222925894",
                thread_metadata: { archived: true, create_timestamp: "2026-10-01T00:00:00+00:00" },
              },
            ],
            first_messages: [{ ...message, id: THREAD, channel_id: THREAD, content: "Question body" }],
            has_more: true,
            total_results: 9,
          })
        : json({ id: FORUM, type: 15, name: "help-posts", guild_id: CHANNEL, available_tags: [{ id: "t1", name: "Solved" }] }),
    );
    const result = await callTool(client, "list_threads", { channel_id: FORUM });
    expect(result.isError).toBeFalsy();
    const [header, line, more] = result.content[0]!.text.split("\n");
    expect(header).toContain("posts 1-1 of 9");
    expect(JSON.parse(line!)).toMatchObject({
      thread_id: THREAD,
      name: "How do I deploy?",
      tags: ["Solved"],
      archived: true,
      started_by: "alice",
      first_post: "Question body",
    });
    expect(more).toContain("offset 1");
    expect(calls[1]!.url).toContain("sort_by=last_message_time");
  });

  it("falls back to active threads when the search endpoint is refused", async () => {
    const { client } = fakeDiscord((c) => {
      if (c.url.includes("/threads/search")) return json({ code: 0, message: "403: Forbidden" }, 403);
      if (c.url.includes("/threads/active")) {
        return json({ threads: [{ id: THREAD, type: 11, name: "Active post", parent_id: FORUM }, { id: "9", type: 11, name: "Other forum", parent_id: "8" }] });
      }
      return json({ id: FORUM, type: 15, name: "help-posts", guild_id: CHANNEL });
    });
    const text = (await callTool(client, "list_threads", { channel_id: FORUM })).content[0]!.text;
    expect(text).toContain("Active post");
    expect(text).not.toContain("Other forum");
  });

  it("refuses ordinary channels and hints at list_threads for forums", async () => {
    const plain = fakeDiscord(() => json({ id: CHANNEL, type: 0, name: "chat" }));
    const notForum = await callTool(plain.client, "list_threads", { channel_id: CHANNEL });
    expect(notForum.isError).toBe(true);
    expect(notForum.content[0]!.text).toContain("not a forum");

    const forum = fakeDiscord((c) => (c.url.includes("/messages") ? json([]) : json({ id: FORUM, type: 15, name: "help-posts" })));
    const read = await callTool(forum.client, "read_messages", { channel_id: FORUM });
    expect(read.isError).toBeFalsy();
    expect(read.content[0]!.text).toContain("list_threads");

    const emptyText = fakeDiscord((c) => (c.url.includes("/messages") ? json([]) : json({ id: CHANNEL, type: 0, name: "chat" })));
    expect((await callTool(emptyText.client, "read_messages", { channel_id: CHANNEL })).content[0]!.text).toBe("No messages.");

    const legacy = fakeDiscord(() => json({ code: 50024, message: "Cannot execute action on this channel type" }, 400));
    expect((await callTool(legacy.client, "read_messages", { channel_id: FORUM })).content[0]!.text).toContain("list_threads");
  });
});

describe("view_image", () => {
  const withImage = { ...message, attachments: [{ url: CDN, filename: "memo.png", content_type: "image/png" }] };

  it("returns an image content block and never sends the token to the CDN", async () => {
    const { client, calls } = fakeDiscord((c) => (c.url.startsWith("https://cdn.discordapp.com") ? imageResponse(PNG) : json(withImage)));
    const result = (await callTool(client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE })) as unknown as {
      isError?: boolean;
      content: { type: string; data?: string; mimeType?: string; text?: string }[];
    };
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("memo.png");
    expect(result.content[1]).toEqual({ type: "image", data: btoa(String.fromCharCode(...PNG)), mimeType: "image/png" });
    expect(calls[1]!.url).toBe(CDN);
  });

  it("sends no Authorization header to the CDN", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const client = new DiscordClient({
      token: "secret-token",
      fetch: async (url, init) => {
        if (url.startsWith("https://cdn.discordapp.com")) {
          seen.push(init);
          return imageResponse(PNG);
        }
        return json(withImage);
      },
    });
    await callTool(client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE });
    expect(JSON.stringify(seen[0]!.headers)).not.toContain("secret-token");
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("downscales through the media proxy when the original is too large", async () => {
    const big = new Uint8Array(4_000_000);
    const { client, calls } = fakeDiscord((c) => {
      if (c.url.startsWith("https://media.discordapp.net")) return imageResponse(PNG, "image/webp");
      if (c.url.startsWith("https://cdn.discordapp.com")) return imageResponse(big);
      return json(withImage);
    });
    const result = await callTool(client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("downscaled");
    expect(calls[2]!.url).toContain("width=1600");
  });

  it("reports messages without images and bad indexes", async () => {
    const none = fakeDiscord(() => json(message));
    expect((await callTool(none.client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE })).content[0]!.text).toContain("no images");
    const some = fakeDiscord(() => json(withImage));
    expect((await callTool(some.client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE, index: 3 })).content[0]!.text).toContain("index must be 0 to 0");
  });

  it("refuses non-Discord hosts and non-image files", async () => {
    const evil = fakeDiscord(() => json({ ...message, attachments: [{ url: "https://evil.example/a.png", content_type: "image/png" }] }));
    const refused = await callTool(evil.client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE });
    expect(refused.isError).toBe(true);
    expect(evil.calls.length).toBe(1);

    const html = fakeDiscord((c) => (c.url.startsWith("https://cdn.discordapp.com") ? new Response("<html>", { headers: { "Content-Type": "text/html" } }) : json(withImage)));
    expect((await callTool(html.client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE })).content[0]!.text).toContain("not a PNG");
  });

  it("opens link-preview images from embeds and lists them in read_messages", async () => {
    const proxy = "https://images-ext-1.discordapp.net/external/abc/https/example.com/pic.jpg";
    const embedded = { ...message, embeds: [{ type: "image", thumbnail: { url: "https://example.com/pic.jpg", proxy_url: proxy } }] };
    const { client, calls } = fakeDiscord((c) => (c.url === proxy ? imageResponse(PNG, "image/jpeg") : json(c.url.includes("/messages?") ? [embedded] : embedded)));
    const listed = await callTool(client, "read_messages", { channel_id: CHANNEL });
    expect(JSON.parse(listed.content[0]!.text.split("\n")[1]!).embed_images).toEqual([proxy]);
    const result = await callTool(client, "view_image", { channel_id: CHANNEL, message_id: MESSAGE });
    expect(result.isError).toBeFalsy();
    expect(calls.at(-1)!.url).toBe(proxy);
  });
});
