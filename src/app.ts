import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { health } from './routes/health';
import { scrape } from './routes/scrape';

export const app = express();

app.set('trust proxy', true);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(pinoHttp());
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

app.use(health);
app.use(scrape);

// Centralized error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({ ok: false, error: 'INTERNAL_ERROR', message: err?.message || 'Unexpected error' });
});