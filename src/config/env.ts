import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT || 3000),
  scrapeTimeoutMs: Number(process.env.SCRAPE_TIMEOUT_MS || 15000),
  scrapeMaxBytes: Number(process.env.SCRAPE_MAX_BYTES || 2_000_000),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  chatpdfApiKey: process.env.CHATPDF_API_KEY || '',
  chatpdfBaseUrl: process.env.CHATPDF_BASE_URL || 'https://api.chatpdf.com/v1',
  contactPhone: process.env.CONTACT_PHONE || '',
  contactName: process.env.CONTACT_NAME || '',
};