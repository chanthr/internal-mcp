/**
 * The console's conversations, kept on this machine: one JSON file per conversation in the data directory
 * (data/chats/<id>.json), readable by the owner only, like the rest of the data directory.
 *
 * A conversation keeps what the page shows: each message, the tools the model called with what they returned
 * (cut to TOOL_TEXT characters: the full result is in the documents), and what the answer cost. The question is
 * kept when it is sent, the answer when it is done, so leaving the page in the middle loses neither.
 *
 * What the model is given of a conversation is its text, newest first, up to HISTORY_CHARS characters: a long
 * conversation does not grow what every new message costs without end.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dataDir } from '../core/paths.js';

export interface StoredCall {
  id: string;
  name: string;
  input: unknown;
  ok?: boolean;
  text?: string;
  ms?: number;
}
export interface StoredTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  calls?: StoredCall[];
  end?: { model: string; usage: { input: number; output: number; cached: number; steps: number }; note: string | null; seconds: number };
  error?: string;
}
export interface Chat {
  id: string;
  title: string;
  created: string;
  updated: string;
  /** An answer is being written now. */
  answering: boolean;
  turns: StoredTurn[];
}
export interface ChatSummary {
  id: string;
  title: string;
  updated: string;
  messages: number;
}

/** Most conversations kept; the oldest go first. */
const MOST = 500;
/** Characters of a tool's result kept with a conversation. */
const TOOL_TEXT = 4_000;
/** Characters of the conversation the model is given with a new message (CHAT_HISTORY_CHARS). */
const historyChars = (): number => Number(process.env.CHAT_HISTORY_CHARS) || 60_000;

const dir = (): string => join(dataDir(), 'chats');
const ID = /^[a-f0-9]{16}$/;
export const chatId = (): string => randomBytes(8).toString('hex');
const fileOf = (id: string): string => {
  if (!ID.test(id)) throw new Error('There is no such conversation.');
  return join(dir(), `${id}.json`);
};

export function readChat(id: string): Chat | null {
  try {
    const f = fileOf(id);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Chat) : null;
  } catch {
    return null;
  }
}

/** Written whole and then moved into place, so a crash in the middle leaves the previous version. */
export function writeChat(chat: Chat): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const f = fileOf(chat.id);
  const trimmed: Chat = { ...chat, turns: chat.turns.map((t) => (t.calls ? { ...t, calls: t.calls.map((c) => ({ ...c, text: c.text && c.text.length > TOOL_TEXT ? `${c.text.slice(0, TOOL_TEXT)}\n… [${c.text.length - TOOL_TEXT} more characters]` : c.text })) } : t)) };
  writeFileSync(`${f}.tmp`, JSON.stringify(trimmed), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

export function deleteChat(id: string): boolean {
  const f = fileOf(id);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}

/** The conversations, newest first. The oldest beyond MOST are removed. */
export function listChats(): ChatSummary[] {
  if (!existsSync(dir())) return [];
  const all: ChatSummary[] = [];
  for (const name of readdirSync(dir())) {
    if (!name.endsWith('.json')) continue;
    const c = readChat(name.slice(0, -5));
    if (c) all.push({ id: c.id, title: c.title, updated: c.updated, messages: c.turns.length });
  }
  all.sort((a, b) => b.updated.localeCompare(a.updated));
  for (const old of all.splice(MOST)) deleteChat(old.id);
  return all;
}

/** A new conversation, titled after its first message. */
export function newChat(first: string): Chat {
  const now = new Date().toISOString();
  const title = first.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Conversation';
  return { id: chatId(), title, created: now, updated: now, answering: false, turns: [] };
}

/**
 * What the model is given of the conversation: the text of each message, newest kept first, up to the budget. Says
 * how many earlier messages were left out, so the model knows the conversation is longer than what it sees.
 */
export function historyOf(chat: Chat): { history: Array<{ role: 'user' | 'assistant'; text: string }>; left: number } {
  const turns = chat.turns.filter((t) => !t.error && t.text.trim());
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let budget = historyChars();
  for (let i = turns.length - 1; i >= 0; i--) {
    budget -= turns[i].text.length;
    // The last question and its answer are always given, however long.
    if (budget < 0 && out.length >= 2) break;
    out.unshift({ role: turns[i].role, text: turns[i].text });
  }
  // A conversation the model sees starts with the person.
  while (out[0]?.role === 'assistant') out.shift();
  return { history: out, left: turns.length - out.length };
}
