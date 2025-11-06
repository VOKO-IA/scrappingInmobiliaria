import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ExtractionService } from './services/extraction';

const app = express();
const port = process.env.PORT || 3000;

// Middleware básico
app.use(cors());
app.use(express.json());

// Instancia del servicio de extracción
const extractionService = new ExtractionService();

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'Cotizador API is running',
    endpoints: [
      'GET /extract?url=<url> - Extract property info with Gemini AI',
      'GET /scrape?url=<url> - Scrape page content only'
    ]
  });
});

// Endpoint para extracción completa (scraping + Gemini AI)
app.get('/extract', async (req, res) => {
  try {
    console.log('Extract request:', req.query);
    const { status, body } = await extractionService.extractFromUrl(req.query);
    return res.status(status).json(body);
  } catch (error) {
    console.error('Extraction error:', error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Endpoint para solo scraping (sin AI)
app.get('/scrape', async (req, res) => {
  try {
    console.log('Scrape request:', req.query);
    const { status, body } = await extractionService.scrapeOnly(req.query);
    return res.status(status).json(body);
  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Manejo de errores global
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Global error:', error);
  res.status(500).json({
    ok: false,
    error: 'INTERNAL_ERROR',
    message: error.message || 'Unknown error'
  });
});

app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log(`📋 Endpoints available:`);
  console.log(`   GET /extract?url=<url> - Extract with Gemini AI`);
  console.log(`   GET /scrape?url=<url> - Scrape only`);
});
