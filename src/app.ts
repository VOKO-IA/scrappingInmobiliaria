import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { scrape } from './routes/scrape';
import { errorHandler } from './middleware/error-handler';

export const app = express();

app.set('trust proxy', false);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(pinoHttp());
app.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Serve local storage (PDFs and extracted images)
app.use('/static', express.static(path.resolve('storage')));

app.use(scrape);

// Centralized error handler
app.use(errorHandler);