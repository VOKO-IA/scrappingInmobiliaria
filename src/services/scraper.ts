import axios from 'axios';
import { load } from 'cheerio';
import { z } from 'zod';
import { isBlockedHost } from '../utils/net';
import { env } from '../config/env';

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

const QuerySchema = z.object({ url: z.string().url().max(2048) });

export async function scrapeFromQuery(query: any) {
  const parsed = QuerySchema.safeParse({ url: query?.url });
  if (!parsed.success) {
    return { status: 400, body: { error: 'INVALID_URL', details: parsed.error.flatten() } };
  }

  const url = parsed.data.url;
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { status: 400, body: { error: 'UNSUPPORTED_PROTOCOL' } };
  }

  const block = await isBlockedHost(u.hostname);
  if (block.blocked) {
    return { status: 400, body: { error: block.reason } };
  }

  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const response = await axios.get<string>(url, {
    timeout: env.scrapeTimeoutMs,
    maxRedirects: 5,
    maxContentLength: env.scrapeMaxBytes,
    maxBodyLength: env.scrapeMaxBytes,
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const html = response.data;
  const $ = load(html);

  $('script,style,noscript,template,svg,canvas,iframe,meta,link,head').remove();

  const title = $('title').first().text().trim();
  const bodyTextRaw = $('body').text();
  const text = bodyTextRaw.replace(/\s+/g, ' ').trim();
  const wordCount = text ? text.split(/\s+/).length : 0;

  return {
    status: 200,
    body: {
      ok: true,
      status: response.status,
      url,
      data: { title, text, charCount: text.length, wordCount },
    },
  };
}