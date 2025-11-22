import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { scrape } from './routes/scrape';
import { errorHandler } from './middleware/error-handler';

export const app = express();

// Render/Cloud providers sit behind a proxy; trust it so req.ip and rate limits work with X-Forwarded-For
app.set('trust proxy', true);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(pinoHttp());
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Serve local storage (PDFs and extracted images)
app.use('/static', express.static(path.resolve('storage')));

// Health/root endpoint to prevent 404s on '/'
app.head('/', (_req, res) => res.status(200).end());
app.get('/', (_req, res) => res.status(200).json({ ok: true, service: 'scraper', status: 'healthy' }));

app.use(scrape);

// Centralized error handler
app.use(errorHandler);