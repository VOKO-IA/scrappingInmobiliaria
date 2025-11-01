import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT || 3000),
  scrapeTimeoutMs: Number(process.env.SCRAPE_TIMEOUT_MS || 15000),
  scrapeMaxBytes: Number(process.env.SCRAPE_MAX_BYTES || 2_000_000),
};