import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

export type HistoryEntry = {
  id: string;
  timestamp: string;
  url: string;
  model?: string | null;
  extracted?: any;
};

const STORAGE_DIR = path.resolve('storage');
const HISTORY_FILE = path.join(STORAGE_DIR, 'history.jsonl');

async function ensureStorage() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, '', 'utf8');
  }
}

export class HistoryService {
  static async append(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<HistoryEntry> {
    await ensureStorage();
    const full: HistoryEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const line = JSON.stringify(full) + '\n';
    await fs.appendFile(HISTORY_FILE, line, 'utf8');
    return full;
  }

  static async list(limit = 50): Promise<HistoryEntry[]> {
    await ensureStorage();
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const parsed: HistoryEntry[] = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try {
        parsed.push(JSON.parse(lines[i]));
      } catch {}
    }
    return parsed.reverse();
  }

  static async getById(id: string): Promise<HistoryEntry | null> {
    await ensureStorage();
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as HistoryEntry;
        if (obj.id === id) return obj;
      } catch {}
    }
    return null;
  }
}
