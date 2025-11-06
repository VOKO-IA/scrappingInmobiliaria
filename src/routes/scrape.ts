import { Router } from 'express';
import { ExtractionService } from '../services/extraction';
import { HistoryService } from '../services/history';
import PDFDocument from 'pdfkit';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../config/env';
import axios from 'axios';

const extractionService = new ExtractionService();

export const scrape = Router();

// Endpoint para extracción completa (scraping + Gemini AI)
scrape.get('/extract', async (req, res) => {
  try {
    const { status, body } = await extractionService.extractFromUrl(req.query);
    if (status === 200 && (body as any)?.ok) {
      try {
        await HistoryService.append({
          url: (body as any).url,
          model: (body as any).model ?? null,
          extracted: (body as any).extracted,
        });
      } catch (e) {
        // no-op: history persistance should not break main flow
      }
    }
    return res.status(status).json(body);
  } catch (error) {
    console.error('Extraction error:', error);
    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred during extraction'
    });
  }
});

// Endpoint para listar historial de consultas
scrape.get('/history', async (req, res) => {
  try {
    const limitRaw = (req.query?.limit as string) || '';
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    const items = await HistoryService.list(limit);
    return res.json({ ok: true, items });
  } catch (error) {
    console.error('History list error:', error);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Failed to read history' });
  }
});

// Endpoint para guardar manualmente una entrada en el historial
scrape.post('/history', async (req, res) => {
  try {
    const { url, model, extracted } = (req as any).body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY', message: 'url is required' });
    }
    const saved = await HistoryService.append({ url, model: model ?? null, extracted });
    return res.status(201).json({ ok: true, entry: saved });
  } catch (error) {
    console.error('History save error:', error);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Failed to save history' });
  }
});

// Generación de documento PDF por ID del historial
scrape.get('/document/:id', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    if (!id) return res.status(400).json({ ok: false, error: 'INVALID_ID' });

    const entry = await HistoryService.getById(id);
    if (!entry) return res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'History entry not found' });

    const data = (entry as any).extracted || {};
    const contactName = env.contactName || data.contactName || '';
    const contactPhone = env.contactPhone || data.contactPhone || '';
    const style = (req.query?.style as string) || 'ml';

    // Configurar headers de respuesta
    const safeTitle = (data.title || 'document').toString().replace(/[^a-z0-9\-_. ]/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeTitle}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 26 });
    doc.pipe(res);

    // Header (logo arriba)
    const leftX = 26;
    const rightX = 569; // A4 595 - margin 26
    try {
      const candidates = ['logo.jpeg', 'logo.jpg', 'logo.png', 'logo.webp'];
      let found: string | null = null;
      for (const name of candidates) {
        const p = path.resolve('public', name);
        try { await fs.access(p); found = p; break; } catch {}
      }
      if (found) {
        doc.image(found, leftX, 6, { width: 110 });
      }
    } catch {}

    // Contacto en header derecha
    const headerY = 8;
    doc.fontSize(10).text('Contacto', rightX - 156, headerY, { width: 156, align: 'right' });
    if (contactName) doc.fontSize(10).text(contactName, rightX - 156, headerY + 14, { width: 156, align: 'right' });
    if (contactPhone) doc.fontSize(10).text(contactPhone, rightX - 156, headerY + 28, { width: 156, align: 'right' });

    // Separador
    const sepY = 58;
    doc.moveTo(leftX, sepY).lineTo(rightX, sepY).strokeColor('#e5e7eb').stroke();

    // Imágenes
    const images: string[] = Array.isArray(data.images) ? data.images : [];
    async function fetchImage(url: string): Promise<Buffer | null> {
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        return Buffer.from(resp.data);
      } catch { return null; }
    }
    // Layout dos columnas (diseño anterior)
    const colLeftX = leftX;
    const colLeftW = 340;
    const colRightX = leftX + colLeftW + 18; // gap 18
    const colRightW = rightX - colRightX;

    const heroUrl = images[0];

    // Hero
    const heroY = 96;
    if (heroUrl) {
      const buf = await fetchImage(heroUrl);
      if (buf) {
        try { doc.image(buf, colLeftX, heroY, { fit: [colLeftW, 320], align: 'center', valign: 'center' }); } catch {}
      } else {
        doc.rect(colLeftX, heroY, colLeftW, 320).strokeColor('#d1d5db').stroke();
      }
    } else {
      doc.rect(colLeftX, heroY, colLeftW, 320).strokeColor('#d1d5db').stroke();
    }

    // (Thumbnails removidos para privilegiar imágenes grandes)

    // Columna derecha detalles
    let y = heroY;
    const title = String(data.title || 'Propiedad');
    doc.fontSize(16).text(title, colRightX, y, { width: colRightW });
    y = doc.y + 8;

    if (data.price != null) {
      const priceLine = `${data.currency ? data.currency + ' ' : ''}${data.price}`;
      doc.fillColor('#10b981').fontSize(22).text(priceLine, colRightX, y, { width: colRightW });
      doc.fillColor('#000000');
      y = doc.y + 8;
    }

    const location = [data.address, data.city, data.state, data.country].filter(Boolean).join(', ');
    if (location) { doc.fontSize(11).fillColor('#374151').text(location, colRightX, y, { width: colRightW }); y = doc.y + 10; }
    doc.fillColor('#000000');

    const quick: string[] = [];
    if (data.bedrooms != null) quick.push(`Recámaras: ${data.bedrooms}`);
    if (data.bathrooms != null) quick.push(`Baños: ${data.bathrooms}`);
    if (data.parkingSpots != null) quick.push(`Estac.: ${data.parkingSpots}`);
    if (data.areaM2 != null) quick.push(`Construcción: ${data.areaM2} m²`);
    if (data.lotM2 != null) quick.push(`Terreno: ${data.lotM2} m²`);
    if (quick.length) { doc.fontSize(11).text(quick.join('   •   '), colRightX, y, { width: colRightW }); y = doc.y + 12; }

    if (Array.isArray(data.amenities) && data.amenities.length) {
      doc.fontSize(12).text('Amenidades', colRightX, y, { width: colRightW, underline: true });
      y = doc.y + 6;
      const list = data.amenities.slice(0, 20).join(', ');
      doc.fontSize(11).text(list, colRightX, y, { width: colRightW });
      y = doc.y + 12;
    }

    if (data.description) {
      doc.fontSize(12).text('Descripción', colRightX, y, { width: colRightW, underline: true });
      y = doc.y + 6;
      doc.fontSize(11).text(String(data.description), colRightX, y, { width: colRightW });
      y = doc.y + 12;
    }

/*     if (entry.url) {
      doc.fontSize(10).fillColor('#2563eb').text(String(entry.url), colRightX, y, { width: colRightW, link: String(entry.url), underline: true });
      doc.fillColor('#000000');
    } */

    // Galería adicional en nueva página (todas las imágenes después del hero)
    const remaining = images.slice(1);
    if (remaining.length > 0) {
      doc.addPage();
      const pageLeftX = leftX;
      const pageRightX = rightX;
      const gridGap = 16;
      const gridCols = 2;
      const gridColW = Math.floor((pageRightX - pageLeftX - gridGap) / gridCols);
      const gridRowH = 260;
      let gx = pageLeftX;
      let gy = 40;
      for (let i = 0; i < remaining.length; i++) {
        const imgBuf = await fetchImage(remaining[i]);
        if (imgBuf) {
          try { doc.image(imgBuf, gx, gy, { fit: [gridColW, gridRowH], align: 'center', valign: 'center' }); } catch {
            doc.rect(gx, gy, gridColW, gridRowH).strokeColor('#d1d5db').stroke();
          }
        } else {
          doc.rect(gx, gy, gridColW, gridRowH).strokeColor('#d1d5db').stroke();
        }
        if ((i % gridCols) === gridCols - 1) {
          gx = pageLeftX;
          gy += gridRowH + gridGap;
          const pageHeightLimit = 800;
          if (gy + gridRowH > pageHeightLimit) {
            doc.addPage();
            gx = pageLeftX;
            gy = 40;
          }
        } else {
          gx += gridColW + gridGap;
        }
      }
    }

    doc.end();
  } catch (error) {
    console.error('Document generate error:', error);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', message: 'Failed to generate document' });
  }
});



