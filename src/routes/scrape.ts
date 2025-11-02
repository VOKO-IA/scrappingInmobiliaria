import { Router } from 'express';
import multer from 'multer';
import axios from 'axios';
import { scrapeFromQuery, extractFromQuery, extractFromPdfUrl, extractFromPdfBuffer, analyzePdfWithGemini, generateInmoReportPdf, generateMultiPropertyReportPdf, InmoExtract } from '../services/scraper';

export const scrape = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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

// Upload a local PDF file and extract content
scrape.post('/pdf/extract/upload', upload.single('file'), async (req, res) => {
  try {
    const file = (req as any).file as any;
    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: 'NO_FILE', message: 'Attach a PDF file in form-data field "file"' });
    }
    const mode = (req.body?.mode || (req.query as any)?.mode || '').toString();
    const analyze = String((req.body?.analyze ?? (req.query as any)?.analyze ?? 'false')).toLowerCase() === 'true';
    const output = ((req.body?.output || (req.query as any)?.output || 'json') as string).toLowerCase();
    const prompt = (req.body?.prompt || (req.query as any)?.prompt || '').toString();

    const { status, body } = await extractFromPdfBuffer({ buffer: file.buffer, mode });
    if (status !== 200 || !body?.extracted) {
      return res.status(status).json(body);
    }

    // Si no se requiere análisis, retornar extracción cruda
    if (!analyze) {
      return res.status(200).json(body);
    }

    // Analizar con Gemini
    try {
      const text = (body.extracted as any)?.text || '';
      const images = (body.extracted as any)?.images || [];
      const url = (body as any)?.url || (body.extracted as any)?.pdf || undefined;
      const { model, extracted } = await analyzePdfWithGemini({ text, images, url, prompt });

      if (output === 'pdf') {
        const { url: reportUrl } = await generateInmoReportPdf({ extracted });
        return res.status(200).json({ ok: true, model, extracted, reportPdf: reportUrl });
      }

      return res.status(200).json({ ok: true, model, extracted });
    } catch (e: any) {
      const message = String(e?.message || e);
      const code = message === 'MISSING_GEMINI_API_KEY' ? 'MISSING_GEMINI_API_KEY' : 'GEMINI_ERROR';
      const http = code === 'MISSING_GEMINI_API_KEY' ? 500 : 500;
      return res.status(http).json({ ok: false, error: code, message });
    }
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || 'AXIOS_ERROR';
      return res.status(status >= 400 && status < 600 ? status : 500).json({ ok: false, error: code, message: err.message });
    }
    return res.status(500).json({ ok: false, error: 'UNKNOWN', message: String(err?.message || err) });
  }
});

scrape.get('/extract', async (req, res) => {
  try {
    const { status, body } = await extractFromQuery(req.query);
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

scrape.post('/pdf/extract', async (req, res) => {
  try {
    const query = { url: req.body?.url, prompt: req.body?.prompt };
    const { status, body } = await extractFromPdfUrl(query);
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

// Generate consolidated PDF report from multiple properties JSON
scrape.post('/pdf/generate-report', async (req, res) => {
  try {
    const { title, properties } = req.body;
    
    if (!properties) {
      return res.status(400).json({ 
        ok: false, 
        error: 'MISSING_PROPERTIES', 
        message: 'Provide properties in request body' 
      });
    }

    // Convert numbered object format to array if needed
    let propsArray: InmoExtract[] = [];
    
    if (Array.isArray(properties)) {
      propsArray = properties as InmoExtract[];
    } else if (typeof properties === 'object') {
      // Handle case where properties is an object with numbered keys like {0: {...}, 1: {...}}
      const keys = Object.keys(properties).filter(k => !isNaN(Number(k))).sort((a, b) => Number(a) - Number(b));
      propsArray = keys.map(k => properties[k] as InmoExtract);
    }

    if (propsArray.length === 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'NO_VALID_PROPERTIES', 
        message: 'No valid properties found in request' 
      });
    }

    const { url: reportUrl } = await generateMultiPropertyReportPdf({ 
      title: title || 'Reporte de Inmuebles',
      properties: propsArray 
    });

    return res.status(200).json({ 
      ok: true, 
      reportPdf: reportUrl,
      propertiesCount: propsArray.length,
      title: title || 'Reporte de Inmuebles'
    });

  } catch (err: any) {
    return res.status(500).json({ 
      ok: false, 
      error: 'PDF_GENERATION_ERROR', 
      message: String(err?.message || err) 
    });
  }
});