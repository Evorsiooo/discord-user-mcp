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
