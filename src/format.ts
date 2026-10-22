// Pure helpers: message shaping, expected-text checks, emoji encoding.

import { isDiscordMediaUrl, type Attachment, type Channel, type Embed, type Message, type User } from "./discord";

const MAX_ATTACHMENTS = 10;

export interface FormattedMessage {
  id: string;
  timestamp: string;
  edited?: true;
  author: { id: string; username: string; display_name?: string };
  content: string;
  reply_to?: string;
  forwarded?: { content: string; attachments?: string[] };
  attachments?: string[];
  embed_images?: string[];
  embeds?: number;
}

const DISCORD_EPOCH_MS = 1420070400000n;

export function snowflakeTime(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length} chars total; use get_message for the full text]`;
}

function attachmentUrls(attachments: Attachment[] | undefined): string[] | undefined {
  if (!attachments?.length) return undefined;
  const urls = attachments.slice(0, MAX_ATTACHMENTS).map((a) => a.url);
  if (attachments.length > MAX_ATTACHMENTS) urls.push(`(+${attachments.length - MAX_ATTACHMENTS} more)`);
  return urls;
}

function isoTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function formatMessage(message: Message, maxContent: number): FormattedMessage {
  const out: FormattedMessage = {
    id: message.id,
    timestamp: isoTimestamp(message.timestamp),
    author: { id: message.author.id, username: message.author.username },
    content: truncate(message.content ?? "", maxContent),
  };
  if (message.edited_timestamp) out.edited = true;
  if (message.author.global_name && message.author.global_name !== message.author.username) {
    out.author.display_name = message.author.global_name;
  }
  // Type 19 is a reply; forwards also carry a message_reference, but with type 1.
  if (message.type === 19 && message.message_reference?.message_id) out.reply_to = message.message_reference.message_id;
  const snapshot = message.message_snapshots?.[0]?.message;
  if (snapshot) {
    out.forwarded = { content: truncate(snapshot.content ?? "", maxContent) };
    const forwardedAttachments = attachmentUrls(snapshot.attachments);
    if (forwardedAttachments) out.forwarded.attachments = forwardedAttachments;
  }
  const attachments = attachmentUrls(message.attachments);
  if (attachments) out.attachments = attachments;
  const embedImages = embedImageUrls(message.embeds);
  if (embedImages.length) out.embed_images = embedImages;
  if (message.embeds?.length) out.embeds = message.embeds.length;
  return out;
}

function embedImageUrls(embeds: Embed[] | undefined): string[] {
  const urls: string[] = [];
  for (const embed of embeds ?? []) {
    // proxy_url is hosted by Discord; the original url can point anywhere.
    const media = embed.image ?? embed.thumbnail;
    const url = media?.proxy_url ?? media?.url;
    if (url && isDiscordMediaUrl(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Every image a message carries, in the order view_image indexes them:
 * file attachments first, then images from link embeds.
 */
export function messageImages(message: Message): { url: string; source: "attachment" | "embed"; label: string }[] {
  const images: { url: string; source: "attachment" | "embed"; label: string }[] = [];
  for (const a of message.attachments ?? []) {
    if (a.content_type ? a.content_type.startsWith("image/") : /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url)) {
      images.push({ url: a.url, source: "attachment", label: a.filename ?? "attachment" });
    }
  }
  for (const url of embedImageUrls(message.embeds)) images.push({ url, source: "embed", label: "embedded image" });
  return images;
}

/** Discord ids are snowflakes; compare them numerically. */
export function compareSnowflakes(a: string | null | undefined, b: string | null | undefined): number {
  const x = BigInt(a ?? 0);
  const y = BigInt(b ?? 0);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function formatDm(channel: Channel) {
  return {
    channel_id: channel.id,
    type: channel.type === 3 ? "group_dm" : "dm",
    ...(channel.name && { name: channel.name }),
    recipients: (channel.recipients ?? []).map((u: User) => ({
      id: u.id,
      username: u.username,
      ...(u.global_name && u.global_name !== u.username && { display_name: u.global_name }),
    })),
    last_message_id: channel.last_message_id ?? null,
  };
}

const CHANNEL_TYPES: Record<number, string> = { 0: "text", 5: "announcement", 15: "forum", 16: "media" };

export function formatGuildChannels(channels: Channel[]) {
  const categories = new Map<string, Channel>();
  for (const c of channels) if (c.type === 4) categories.set(c.id, c);
  const categoryPosition = (c: Channel) => (c.parent_id ? (categories.get(c.parent_id)?.position ?? -1) : -1);
  return channels
    .filter((c) => c.type in CHANNEL_TYPES)
    .sort((a, b) => categoryPosition(a) - categoryPosition(b) || (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({
      id: c.id,
      name: c.name ?? "",
      type: CHANNEL_TYPES[c.type]!,
      category: c.parent_id ? (categories.get(c.parent_id)?.name ?? null) : null,
    }));
}

export function formatThread(thread: Channel, tagNames: Map<string, string>, firstMessage?: Message) {
  const tags = (thread.applied_tags ?? []).map((id) => tagNames.get(id) ?? id);
  const last = thread.last_message_id ?? thread.id;
  return {
    thread_id: thread.id,
    name: thread.name ?? "",
    ...(tags.length && { tags }),
    created: thread.thread_metadata?.create_timestamp ?? snowflakeTime(thread.id),
    last_activity: snowflakeTime(last),
    ...(thread.message_count !== undefined && { messages: thread.message_count }),
    ...(thread.thread_metadata?.archived && { archived: true }),
    ...(thread.thread_metadata?.locked && { locked: true }),
    ...((thread.flags ?? 0) & 2 ? { pinned: true } : {}),
    ...(firstMessage && {
      started_by: firstMessage.author.username,
      first_post: truncate(firstMessage.content ?? "", 200),
      ...(firstMessage.attachments?.length ? { first_post_attachments: firstMessage.attachments.length } : {}),
    }),
  };
}

const MIN_EXPECTED_CHARS = 15;

function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Checks that `expected` is the start of `actual`, ignoring whitespace
 * differences and a trailing "..." or "…". Returns a refusal reason, or null
 * when it matches.
 */
export function checkTextStart(actual: string, expected: string, field: string): string | null {
  const a = normalizeText(actual);
  const e = normalizeText(expected).replace(/(\.\.\.|…)$/, "").trimEnd();
  const preview = JSON.stringify(a.slice(0, 60));
  if (a === "") {
    return e === "" ? null : `Refused: ${field} does not match. The message has no text content (attachments or embeds only); pass an empty string.`;
  }
  const minLength = Math.min(MIN_EXPECTED_CHARS, a.length);
  if (e.length < minLength) {
    return `Refused: ${field} must contain at least the first ${minLength} characters of the message. Call get_message and copy its opening text.`;
  }
  if (!a.startsWith(e)) {
    return `Refused: ${field} does not match. The message actually starts with ${preview}. Call get_message, show the message to the user, and confirm before trying again.`;
  }
  return null;
}

/** Accepts a user id, username, or display name, with or without a leading "@". */
export function checkAuthor(author: User, expected: string): string | null {
  const e = expected.trim().replace(/^@/, "").toLowerCase();
  const candidates = [author.id, author.username, author.global_name ?? ""].map((v) => v.toLowerCase());
  if (e && candidates.includes(e)) return null;
  const actual = author.global_name ? `${author.username} (display name "${author.global_name}", id ${author.id})` : `${author.username} (id ${author.id})`;
  return `Refused: expected_author does not match. The message was written by ${actual}. Call get_message, show the message to the user, and confirm before trying again.`;
}

/**
 * Returns the URL path segment for a reaction emoji. Accepts a unicode emoji,
 * or a custom emoji as `name:id`, `:name:id` or `<:name:id>` / `<a:name:id>`.
 */
export function encodeEmoji(input: string): string {
  const s = input.trim();
  const custom = s.match(/^<a?:(\w+):(\d{17,20})>$/) ?? s.match(/^:?(\w+):(\d{17,20})$/);
  if (custom) return encodeURIComponent(`${custom[1]}:${custom[2]}`);
  if (/^:[\w+-]+:$/.test(s)) {
    throw new Error(`"${s}" is a shortcode. Pass the unicode emoji character itself (for example 👍), or name:id for a custom emoji.`);
  }
  // Unicode emoji always contain a non-ASCII code point (keycaps like 1️⃣ add U+FE0F/U+20E3).
  if (s === "" || /^[\x00-\x7f]*$/.test(s) || s.length > 32) {
    throw new Error(`"${s}" is not an emoji. Pass a unicode emoji character, or name:id for a custom emoji.`);
  }
  return encodeURIComponent(s);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
