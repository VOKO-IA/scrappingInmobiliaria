import { Router } from 'express';
import axios from 'axios';
import { scrapeFromQuery } from '../services/scraper';

export const scrape = Router();

scrape.get('/scrape', async (req, res) => {
  try {
    const { status, body } = await scrapeFromQuery(req.query);
    return res.status(status).json(body);
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || 'AXIOS_ERROR';
      return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: code, message: err.message });
    }
    return res.status(500).json({ ok: false, error: 'UNKNOWN', message: String(err?.message || err) });
  }
});