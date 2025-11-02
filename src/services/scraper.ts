import axios from 'axios';
import { load } from 'cheerio';
import { z } from 'zod';
import { isBlockedHost } from '../utils/net'; // Asumiendo esta ruta
import { env } from '../config/env'; // Asumiendo esta ruta
import { GoogleGenerativeAI } from '@google/generative-ai';
import pdfParse from 'pdf-parse';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { createCanvas } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';

// Tipo de salida para análisis inmobiliario
export type InmoExtract = {
  title: string | null;
  price: number | null;
  currency: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  parkingSpots: number | null;
  areaM2: number | null;
  lotM2: number | null;
  amenities: string[];
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  description: string | null;
  images: string[];
  url?: string;
  _raw?: any;
};

// --- Constantes ---

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

const QuerySchema = z.object({ url: z.string().url().max(2048) });

// --- Tipos de Datos (Recomendados) ---

// Define la estructura de los datos extraídos por Cheerio
interface ScrapedData {
  title: string;
  text: string;
  charCount: number;
  wordCount: number;
  images: Array<any>; // Puedes tipar esto más precisamente
  figures: Array<any>; // Puedes tipar esto más precisamente
}

export async function extractFromPdfBuffer(input: { buffer: Buffer; mode?: string }): Promise<ScrapeResult> {
  try {
    const buffer = input.buffer;
    const parsed = await pdfParse(buffer);
    const mode = (input?.mode || '').toString();

    if (mode === 'embedded') {
      try {
        const storageRoot = path.resolve('storage');
        const id = `pdf_${Date.now()}`;
        const outDir = path.join(storageRoot, id);
        await fs.mkdir(outDir, { recursive: true });
        const pdfPath = path.join(outDir, 'input.pdf');
        await fs.writeFile(pdfPath, buffer);

        const files = await extractEmbeddedImagesToDir(buffer, outDir);
        const urls = files.map((f) => `/static/${id}/${f}`);
        return {
          status: 200,
          body: {
            ok: true,
            extracted: {
              text: parsed.text || '',
              numpages: (parsed as any).numpages,
              info: (parsed as any).info,
              metadata: (parsed as any).metadata,
              version: (parsed as any).version,
              pdf: `/static/${id}/input.pdf`,
              images: urls,
            },
          },
        };
      } catch (e: any) {
        if (String(e?.message) === 'PDFIMAGES_NOT_AVAILABLE') {
          return {
            status: 500,
            body: {
              ok: false,
              error: 'PDFIMAGES_NOT_AVAILABLE',
              message: 'The pdfimages CLI (Poppler) is not installed or not in PATH.',
              details: { install: 'sudo dnf install -y poppler-utils' },
            },
          };
        }
        return { status: 500, body: { ok: false, error: 'PDF_EXTRACT_ERROR', message: String(e?.message || e) } };
      }
    }

    try {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
      (pdfjsLib as any).GlobalWorkerOptions.workerSrc = require('pdfjs-dist/legacy/build/pdf.worker.js');
      const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
      const standardFontDataUrl = pdfjsDistPath + '/standard_fonts/';
      const cMapUrl = pdfjsDistPath + '/cmaps/';
      const data = new Uint8Array(buffer);
      const loadingTask: any = (pdfjsLib as any).getDocument({
        data,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
      });
      const pdf = await loadingTask.promise;
      const images: string[] = [];
      const maxPages =  typeof (undefined) === 'number' ? 1 : pdf.numPages;
      for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        const renderContext = { canvasContext: ctx as any, viewport } as any;
        await page.render(renderContext).promise;
        images.push(canvas.toDataURL('image/png'));
      }
      return {
        status: 200,
        body: {
          ok: true,
          extracted: {
            text: parsed.text || '',
            numpages: (parsed as any).numpages,
            info: (parsed as any).info,
            metadata: (parsed as any).metadata,
            version: (parsed as any).version,
            images,
          },
        },
      };
    } catch (e: any) {
      return {
        status: 200,
        body: {
          ok: true,
          extracted: {
            text: parsed.text || '',
            numpages: (parsed as any).numpages,
            info: (parsed as any).info,
            metadata: (parsed as any).metadata,
            version: (parsed as any).version,
            images: [],
          },
        },
      };
    }
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || 'AXIOS_ERROR';
      return {
        status: status >= 400 && status < 600 ? status : 500,
        body: { ok: false, error: code, message: err.message, details: err.response?.data },
      };
    }
    return { status: 500, body: { ok: false, error: 'PDF_EXTRACT_ERROR', message: String(err?.message || err) } };
  }
}

// ----------------------------------------------------------------------------------
// 🤖 Análisis de PDF con Gemini (texto + imágenes) y generación de reporte PDF
// ----------------------------------------------------------------------------------

export async function analyzePdfWithGemini(input: { text: string; images?: string[]; url?: string; prompt?: string }): Promise<{ model: string; extracted: InmoExtract }> {
  if (!env.geminiApiKey) {
    throw new Error('MISSING_GEMINI_API_KEY');
  }
  const modelName = env.geminiModel || 'gemini-1.5-flash';
  const genAI = new GoogleGenerativeAI(env.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  const schema = {
    title: 'string',
    price: 'number|null',
    currency: 'string|null',
    address: 'string|null',
    city: 'string|null',
    state: 'string|null',
    postalCode: 'string|null',
    country: 'string|null',
    bedrooms: 'number|null',
    bathrooms: 'number|null',
    parkingSpots: 'number|null',
    areaM2: 'number|null',
    lotM2: 'number|null',
    amenities: 'string[]',
    contactName: 'string|null',
    contactPhone: 'string|null',
    contactEmail: 'string|null',
    description: 'string|null',
    images: 'string[]',
    url: 'string|null'
  } as const;

  const userPrompt = (input?.prompt || '').toString();
  const prompt = `You are an information extraction engine for real-estate brochures in PDF. Extract the following JSON strictly with the given key casing. If unknown, use null. No prose, no markdown.

JSON shape:
${JSON.stringify(schema, null, 2)}

Rules:
- Output only one JSON object. No extra text.
- Parse prices and choose a currency code if explicit (e.g., MXN, USD, EUR); else null.
- Numbers must be numeric (no units or commas). Areas in square meters.
- Use a concise description based on the text if available.
- Use up to 10 relevant image URLs provided.
${userPrompt ? `\nAdditional instructions from user: ${userPrompt}` : ''}

Context:
URL: ${input.url || ''}
TEXT:
${(input.text || '').slice(0, 120000)}

IMAGE_URLS:
${(input.images || []).slice(0, 20).join('\n')}
`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  const raw = result.response.text();
  let extracted: any;
  try { extracted = JSON.parse(raw); } catch { extracted = { _raw: raw, parseError: 'JSON_PARSE_FAIL' }; }

  const out: InmoExtract = {
    title: null,
    price: null,
    currency: null,
    address: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    bedrooms: null,
    bathrooms: null,
    parkingSpots: null,
    areaM2: null,
    lotM2: null,
    amenities: [],
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    description: null,
    images: Array.isArray(input.images) ? input.images.slice(0, 10) : [],
    url: input.url,
    ...extracted,
  };
  return { model: modelName, extracted: out };
}

export async function generateInmoReportPdf(params: { extracted: InmoExtract; filename?: string }): Promise<{ filePath: string; url: string }> {
  const storageRoot = path.resolve('storage');
  await fs.mkdir(storageRoot, { recursive: true });
  const id = `report_${Date.now()}`;
  const fileName = params.filename || `${id}.pdf`;
  const outPath = path.join(storageRoot, fileName);

  const doc = new PDFDocument({ autoFirstPage: true, margin: 50 });
  const stream = doc.pipe((await fs.open(outPath, 'w')).createWriteStream());

  const H1 = 20;
  const H2 = 14;
  const body = 11;
  const sep = 10;

  const ex = params.extracted;

  doc.fontSize(H1).text(ex.title || 'Inmueble', { underline: true });
  doc.moveDown();

  doc.fontSize(H2).text('Resumen');
  doc.moveDown(0.2);
  doc.fontSize(body)
    .text(`Precio: ${ex.price ?? '-'} ${ex.currency ?? ''}`)
    .text(`Dirección: ${ex.address ?? '-'}`)
    .text(`Ciudad/Estado: ${(ex.city ?? '-')}/${ex.state ?? '-'}`)
    .text(`CP/Pais: ${(ex.postalCode ?? '-')}/${ex.country ?? '-'}`);
  doc.moveDown();

  doc.fontSize(H2).text('Detalles');
  doc.moveDown(0.2);
  doc.fontSize(body)
    .text(`Recámaras: ${ex.bedrooms ?? '-'}`)
    .text(`Baños: ${ex.bathrooms ?? '-'}`)
    .text(`Estacionamientos: ${ex.parkingSpots ?? '-'}`)
    .text(`Construcción (m²): ${ex.areaM2 ?? '-'}`)
    .text(`Terreno (m²): ${ex.lotM2 ?? '-'}`)
    .text(`Amenidades: ${Array.isArray(ex.amenities) && ex.amenities.length ? ex.amenities.join(', ') : '-'}`);
  doc.moveDown();

  if (ex.description) {
    doc.fontSize(H2).text('Descripción');
    doc.moveDown(0.2);
    doc.fontSize(body).text(ex.description, { align: 'justify' });
    doc.moveDown();
  }

  if (Array.isArray(ex.images) && ex.images.length) {
    doc.addPage();
    doc.fontSize(H2).text('Imágenes');
    doc.moveDown(0.5);
    // Nota: si son data URLs, pdfkit no soporta directamente. Saltamos render si no son rutas de archivo.
    const imgs = ex.images.filter((u) => typeof u === 'string' && u.startsWith('/static/'));
    const colW = 250;
    let x = doc.x;
    let y = doc.y;
    for (const u of imgs.slice(0, 6)) {
      try {
        const file = path.join(process.cwd(), u.replace(/^\/static\//, 'storage/'));
        doc.image(file, x, y, { width: 200, fit: [colW, colW] });
      } catch {}
      x += colW + 10;
      if (x > doc.page.width - doc.page.margins.right - colW) { x = doc.x; y += colW + 10; }
    }
  }

  doc.moveDown();
  doc.fontSize(body).text(`Fuente: ${ex.url || '-'}`);
  doc.moveDown(0.2);
  doc.fontSize(body).text(`Generado: ${new Date().toISOString()}`);

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', (e: any) => reject(e));
  });

  return { filePath: outPath, url: `/static/${path.basename(outPath)}` };
}

export async function generateMultiPropertyReportPdf(params: { 
  title?: string; 
  properties: InmoExtract[]; 
  filename?: string 
}): Promise<{ filePath: string; url: string }> {
  const storageRoot = path.resolve('storage');
  await fs.mkdir(storageRoot, { recursive: true });
  const id = `multi_report_${Date.now()}`;
  const fileName = params.filename || `${id}.pdf`;
  const outPath = path.join(storageRoot, fileName);

  const doc = new PDFDocument({ autoFirstPage: true, margin: 50 });
  const stream = doc.pipe((await fs.open(outPath, 'w')).createWriteStream());

  const H1 = 24;
  const H2 = 16;
  const H3 = 14;
  const body = 11;
  const small = 9;

  const title = params.title || 'Reporte de Inmuebles';
  const properties = params.properties || [];

  // Portada
  doc.fontSize(H1).text(title, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(H2).text(`${properties.length} Propiedades`, { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(body).text(`Generado: ${new Date().toLocaleDateString('es-MX')}`, { align: 'center' });
  doc.moveDown(2);

  // Resumen ejecutivo
  doc.fontSize(H2).text('Resumen Ejecutivo');
  doc.moveDown(0.5);

  const totalValue = properties.reduce((sum, p) => sum + (p.price || 0), 0);
  const totalArea = properties.reduce((sum, p) => sum + (p.areaM2 || 0), 0);
  const avgPrice = properties.length > 0 ? totalValue / properties.length : 0;

  doc.fontSize(body)
    .text(`Valor total del portafolio: $${totalValue.toLocaleString('es-MX')} ${properties[0]?.currency || 'MXN'}`)
    .text(`Área total construida: ${totalArea.toLocaleString('es-MX')} m²`)
    .text(`Precio promedio: $${avgPrice.toLocaleString('es-MX')} ${properties[0]?.currency || 'MXN'}`)
    .moveDown();

  // Tabla resumen
  doc.fontSize(H3).text('Resumen por Propiedad');
  doc.moveDown(0.3);

  const tableY = doc.y;
  const colWidths = [120, 80, 100, 80, 80];
  const headers = ['Ciudad', 'Precio (MXN)', 'Área (m²)', 'Estac.', 'Estado'];
  
  let x = doc.x;
  headers.forEach((header, i) => {
    doc.fontSize(small).text(header, x, tableY, { width: colWidths[i], align: 'left' });
    x += colWidths[i];
  });

  let currentY = tableY + 20;
  properties.forEach((prop, idx) => {
    if (currentY > doc.page.height - 100) {
      doc.addPage();
      currentY = doc.y;
    }
    
    x = doc.x;
    const rowData = [
      prop.city || '-',
      prop.price ? `$${prop.price.toLocaleString('es-MX')}` : '-',
      prop.areaM2 ? `${prop.areaM2.toLocaleString('es-MX')}` : '-',
      prop.parkingSpots?.toString() || '-',
      prop.state || '-'
    ];

    rowData.forEach((data, i) => {
      doc.fontSize(small).text(data, x, currentY, { width: colWidths[i], align: 'left' });
      x += colWidths[i];
    });
    currentY += 15;
  });

  // Secciones detalladas por inmueble
  properties.forEach((prop, idx) => {
    doc.addPage();
    
    doc.fontSize(H2).text(`${idx + 1}. ${prop.title || `Inmueble ${idx + 1}`}`);
    doc.moveDown(0.5);

    // Información principal
    doc.fontSize(H3).text('Información General');
    doc.moveDown(0.2);
    doc.fontSize(body)
      .text(`Precio: ${prop.price ? `$${prop.price.toLocaleString('es-MX')} ${prop.currency || 'MXN'}` : 'No especificado'}`)
      .text(`Dirección: ${prop.address || 'No especificada'}`)
      .text(`Ciudad: ${prop.city || '-'}, ${prop.state || '-'}`)
      .text(`CP: ${prop.postalCode || '-'}, ${prop.country || '-'}`)
      .moveDown();

    // Características
    doc.fontSize(H3).text('Características');
    doc.moveDown(0.2);
    doc.fontSize(body)
      .text(`Área construida: ${prop.areaM2 ? `${prop.areaM2.toLocaleString('es-MX')} m²` : 'No especificada'}`)
      .text(`Área de terreno: ${prop.lotM2 ? `${prop.lotM2.toLocaleString('es-MX')} m²` : 'No especificada'}`)
      .text(`Recámaras: ${prop.bedrooms || 'No especificadas'}`)
      .text(`Baños: ${prop.bathrooms || 'No especificados'}`)
      .text(`Estacionamientos: ${prop.parkingSpots || 'No especificados'}`)
      .moveDown();

    // Amenidades
    if (Array.isArray(prop.amenities) && prop.amenities.length > 0) {
      doc.fontSize(H3).text('Amenidades');
      doc.moveDown(0.2);
      doc.fontSize(body).text(prop.amenities.join(', '));
      doc.moveDown();
    }

    // Descripción
    if (prop.description) {
      doc.fontSize(H3).text('Descripción');
      doc.moveDown(0.2);
      doc.fontSize(body).text(prop.description, { align: 'justify' });
      doc.moveDown();
    }

    // Contacto
    if (prop.contactName || prop.contactPhone || prop.contactEmail) {
      doc.fontSize(H3).text('Contacto');
      doc.moveDown(0.2);
      doc.fontSize(body);
      if (prop.contactName) doc.text(`Nombre: ${prop.contactName}`);
      if (prop.contactPhone) doc.text(`Teléfono: ${prop.contactPhone}`);
      if (prop.contactEmail) doc.text(`Email: ${prop.contactEmail}`);
      doc.moveDown();
    }

    // Fuente
    if (prop.url) {
      doc.fontSize(small).text(`Fuente: ${prop.url}`, { align: 'right' });
    }
  });

  // Pie final
  doc.addPage();
  doc.fontSize(H2).text('Información del Reporte', { align: 'center' });
  doc.moveDown();
  doc.fontSize(body)
    .text(`Fecha de generación: ${new Date().toLocaleString('es-MX')}`, { align: 'center' })
    .text(`Total de propiedades: ${properties.length}`, { align: 'center' })
    .text(`Valor total: $${totalValue.toLocaleString('es-MX')} ${properties[0]?.currency || 'MXN'}`, { align: 'center' });

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', (e: any) => reject(e));
  });

  return { filePath: outPath, url: `/static/${path.basename(outPath)}` };
}

// Extrae imágenes embebidas a un directorio específico y devuelve los nombres de archivo
async function extractEmbeddedImagesToDir(buffer: Buffer, outDir: string): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const inputPath = path.join(outDir, 'input.pdf');
  await fs.writeFile(inputPath, buffer);
  try {
    await execRun('pdfimages', ['-png', inputPath, 'img'], outDir);
  } catch (e: any) {
    if (/ENOENT|not found|No such file or directory/i.test(String(e?.message))) {
      throw new Error('PDFIMAGES_NOT_AVAILABLE');
    }
    throw e;
  }
  const files = await fs.readdir(outDir);
  const exts = new Set(['.png', '.jpg', '.jpeg', '.ppm', '.pbm', '.pnm']);
  const outs = files.filter((f) => f.startsWith('img') && exts.has(path.extname(f).toLowerCase()));
  return outs.sort();
}

// Define la respuesta completa del scraping
interface ScrapeResult {
  status: number;
  body: {
    // Propiedades comunes (para éxito y error)
    ok?: boolean;
    url?: string;
    message?: string;
    error?: string;
    details?: any;

    // Propiedades específicas del SCRAPE (Función 1)
    status?: number;
    data?: ScrapedData;

    // Propiedades específicas de la EXTRACCIÓN con Gemini (Función 2)
    model?: string;        // <--- ¡Añadida!
    extracted?: any;      // <--- ¡Añadida!

    // Propiedades específicas de ChatPDF (Función 3)
    sourceId?: string;
    answer?: any;
  };
}
// --- Funciones de Utilidad ---

// Función para resolver URLs relativas a absolutas
const resolveUrl = (maybeUrl?: string, baseUrl?: string) => {
  if (!maybeUrl || !baseUrl) return undefined;
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return undefined;
  }
};

const parseSrcSet = (raw?: string) => {
  if (!raw) return [] as Array<{ url: string; descriptor?: string }>;
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const [u, d] = part.split(/\s+/, 2);
      const abs = resolveUrl(u, ''); // Base URL no es necesaria aquí si solo se resuelve internamente
      return abs ? { url: abs, descriptor: d } : undefined;
    })
    .filter(Boolean) as Array<{ url: string; descriptor?: string }>;
};

const isSvgUrl = (u?: string) => {
  if (!u) return false;
  const s = u.toLowerCase();
  return s.startsWith('data:image/svg+xml') || /\.svg(?:$|[?#])/.test(s) || s.includes('image/svg+xml');
};

const MIN_DIMENSION_PX = 150;
const cssPx = (style?: string, prop?: string): number | undefined => {
  if (!style || !prop) return undefined;
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`, 'i'));
  return m ? Number(m[1]) : undefined;
};

// Ejecutar un binario externo y devolver stdout/stderr
const execRun = (file: string, args: string[], cwd?: string) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { cwd }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message)));
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });

// Extrae imágenes embebidas con la herramienta 'pdfimages' (Poppler)
async function extractEmbeddedImagesWithPdfImages(buffer: Buffer): Promise<string[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdfx-'));
  const inputPath = path.join(tmpDir, 'input.pdf');
  await fs.writeFile(inputPath, buffer);

  try {
    await execRun('pdfimages', ['-png', inputPath, 'img'], tmpDir);
  } catch (e: any) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (/ENOENT|not found|No such file or directory/i.test(String(e?.message))) {
      throw new Error('PDFIMAGES_NOT_AVAILABLE');
    }
    throw e;
  }

  const files = await fs.readdir(tmpDir);
  const exts = new Set(['.png', '.jpg', '.jpeg', '.ppm', '.pbm', '.pnm']);
  const outs = files.filter((f) => f.startsWith('img') && exts.has(path.extname(f).toLowerCase()));
  const images: string[] = [];
  for (const f of outs) {
    const b = await fs.readFile(path.join(tmpDir, f));
    const ext = path.extname(f).toLowerCase().slice(1) || 'png';
    images.push(`data:image/${ext};base64,${b.toString('base64')}`);
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  return images;
}


// ----------------------------------------------------------------------------------
// 🚀 FUNCIÓN 1: SCRAPE (Obtener y Parsear HTML)
// ----------------------------------------------------------------------------------

export async function scrapeFromQuery(query: any): Promise<ScrapeResult> {
  // 1. Validar la URL
  const parsed = QuerySchema.safeParse({ url: query?.url });
  if (!parsed.success) {
    return { status: 400, body: { error: 'INVALID_URL', details: parsed.error.flatten() } };
  }
  
  // Se define 'url' para que el código posterior lo encuentre (solución al error 2552)
  const url = parsed.data.url; 

  // 2. Comprobaciones de URL y Bloqueo
  const u = new URL(url); // Ahora 'url' está definida
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { status: 400, body: { error: 'UNSUPPORTED_PROTOCOL' } };
  }

  const block = await isBlockedHost(u.hostname);
  if (block.blocked) {
    return { status: 400, body: { error: block.reason } };
  }

  try {
    // 3. Petición HTTP (Axios)
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

    // 4. Procesamiento con Cheerio
    const html = response.data;
    const $ = load(html);

    $('script,style,noscript,template,svg,canvas,iframe,meta,link,head').remove();

    const title = $('title').first().text().trim();

    // Reutilizar la función resolveUrl con la url base
    const localResolveUrl = (maybeUrl?: string) => resolveUrl(maybeUrl, url);

    const parseSrcSet = (raw?: string) => {
      if (!raw) return [] as Array<{ url: string; descriptor?: string }>;
      return raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((part) => {
          const [u, d] = part.split(/\s+/, 2);
          const abs = localResolveUrl(u);
          return abs ? { url: abs, descriptor: d } : undefined;
        })
        .filter(Boolean) as Array<{ url: string; descriptor?: string }>;
    };

    // Lógica de extracción de imágenes
    const images = $('img')
      .map((_, el) => {
        const $el = $(el);
        const src = $el.attr('src')?.trim();
        const absSrc = localResolveUrl(src); // Usamos la función local
        const srcsetRaw = $el.attr('srcset')?.trim();
        // ... (resto de la lógica de imágenes)
        const sizes = $el.attr('sizes')?.trim();
        const alt = $el.attr('alt')?.trim();
        const titleAttr = $el.attr('title')?.trim();
        const loading = $el.attr('loading')?.trim();
        const decoding = $el.attr('decoding')?.trim();
        const widthAttr = Number($el.attr('width')) || undefined;
        const heightAttr = Number($el.attr('height')) || undefined;
        const style = $el.attr('style')?.trim();
        const widthStyle = cssPx(style, 'width');
        const heightStyle = cssPx(style, 'height');
        const width = widthAttr ?? widthStyle;
        const height = heightAttr ?? heightStyle;
        const referrerpolicy = $el.attr('referrerpolicy')?.trim();
        const crossorigin = $el.attr('crossorigin')?.trim();

        if ((width !== undefined && width <= MIN_DIMENSION_PX) || (height !== undefined && height <= MIN_DIMENSION_PX)) {
          return undefined;
        }

        if (absSrc && isSvgUrl(absSrc)) {
          return undefined;
        }

        const srcsetParsed = parseSrcSet(srcsetRaw).filter((e) => !isSvgUrl(e.url));

        if (!absSrc && srcsetParsed.length === 0) {
          return undefined;
        }

        const attr = {
          src: src || undefined,
          absSrc,
          alt,
          title: titleAttr,
          width,
          height,
          loading,
          decoding,
          referrerPolicy: referrerpolicy,
          crossorigin,
          sizes,
          srcset: srcsetParsed,
        };
        return attr;
      })
      .get()
      .filter(Boolean) as Array<any>; // Usar 'any' temporalmente

    // Lógica de extracción de figures
    const figures = $('figure')
      .map((_, el) => {
        const $fig = $(el);
        const caption = $fig.find('figcaption').text().replace(/\s+/g, ' ').trim();
        const figImages = $fig
          .find('img')
          .map((__, img) => {
            const $img = $(img);
            const src = $img.attr('src')?.trim();
            const absSrc = localResolveUrl(src); // Usamos la función local
            const srcsetRaw = $img.attr('srcset')?.trim();
            const alt = $img.attr('alt')?.trim();
            const titleAttr = $img.attr('title')?.trim();
            const widthAttr = Number($img.attr('width')) || undefined;
            const heightAttr = Number($img.attr('height')) || undefined;
            const style = $img.attr('style')?.trim();
            const widthStyle = cssPx(style, 'width');
            const heightStyle = cssPx(style, 'height');
            const width = widthAttr ?? widthStyle;
            const height = heightAttr ?? heightStyle;

            if ((width !== undefined && width <= MIN_DIMENSION_PX) || (height !== undefined && height <= MIN_DIMENSION_PX)) {
              return undefined;
            }

            if (absSrc && isSvgUrl(absSrc)) {
              return undefined;
            }

            const srcsetParsed = parseSrcSet(srcsetRaw).filter((e) => !isSvgUrl(e.url));
            if (!absSrc && srcsetParsed.length === 0) {
              return undefined;
            }

            return {
              src: src || undefined,
              absSrc,
              alt,
              title: titleAttr,
              width,
              height,
              srcset: srcsetParsed,
            };
          })
          .get()
          .filter(Boolean) as Array<any>; // Usar 'any' temporalmente
        return { caption, images: figImages };
      })
      .get();

    const bodyTextRaw = $('body').text();
    const text = bodyTextRaw.replace(/\s+/g, ' ').trim();
    const wordCount = text ? text.split(/\s+/).length : 0;

    // 5. Devolver resultado exitoso
    return {
      status: 200,
      body: {
        ok: true,
        status: response.status,
        url,
        data: { title, text, charCount: text.length, wordCount, images, figures },
      } as ScrapeResult['body'],
    };

  } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const code = error.code || 'AXIOS_ERROR';
        return { 
            status: status >= 400 && status < 600 ? status : 500,
            body: { ok: false, error: code, message: error.message }
        };
      }
      return { status: 500, body: { ok: false, error: 'SCRAPE_UNKNOWN', message: String(error?.message || error) } };
  }
}

// ----------------------------------------------------------------------------------
// 🤖 FUNCIÓN 2: EXTRACT (Usar datos del scraping y Gemini)
// ----------------------------------------------------------------------------------

export async function extractFromQuery(query: any): Promise<ScrapeResult> {
  if (!env.geminiApiKey) {
    return { status: 500, body: { ok: false, error: 'MISSING_GEMINI_API_KEY', message: 'Set GEMINI_API_KEY in .env' } };
  }

  // 1. Obtener los datos del scraping
  const scraped = await scrapeFromQuery(query);
  if (scraped.status !== 200 || !scraped.body?.data) {
    return scraped; // Devuelve el error si el scraping falló
  }

  const { url, data } = { url: (scraped.body.url as string), data: scraped.body.data as ScrapedData };

  // 2. Preparar los datos para Gemini
  const images: string[] = [
    ...(Array.isArray(data.images) ? data.images.map((i: any) => i.absSrc).filter(Boolean) : []),
    ...(Array.isArray(data.figures)
      ? data.figures.flatMap((f: any) => (Array.isArray(f.images) ? f.images.map((i: any) => i.absSrc).filter(Boolean) : []))
      : []),
  ].slice(0, 20);

  const modelName = env.geminiModel || 'gemini-1.5-flash';
  const genAI = new GoogleGenerativeAI(env.geminiApiKey);
  const model = genAI.getGenerativeModel({ model: modelName });

  // 3. Definición del Esquema
  const schema = {
    title: 'string',
    price: 'number|null',
    currency: 'string|null',
    address: 'string|null',
    city: 'string|null',
    state: 'string|null',
    postalCode: 'string|null',
    country: 'string|null',
    bedrooms: 'number|null',
    bathrooms: 'number|null',
    parkingSpots: 'number|null',
    areaM2: 'number|null',
    lotM2: 'number|null',
    amenities: 'string[]',
    contactName: 'string|null',
    contactPhone: 'string|null',
    contactEmail: 'string|null',
    description: 'string|null',
    images: 'string[]',
    url: 'string',
  } as const;

  // 4. Construcción del Prompt
  const prompt = `You are an information extraction engine. Given the web page text content and image URLs from a real-estate or general product/service page, extract the essential fields and return strictly JSON (no prose). If a field is unknown, use null. Follow this JSON shape and key casing strictly.

JSON shape:
${JSON.stringify(schema, null, 2)}

Rules:
- Only output a single JSON object. No markdown, no explanations.
- Parse prices, choose a currency code if explicit (e.g., MXN, USD, EUR), else null.
- Numbers must be numbers (no units or commas). Areas should be in square meters if possible.
- Use description as a concise summary from the text if available.
- Use up to 10 of the most relevant image URLs provided.

Context:
URL: ${url}
TITLE: ${data.title || ''}
TEXT:
${(data.text || '').slice(0, 120000)}

IMAGE_URLS:
${images.join('\n')}
`;

  try {
    // 5. Llamada a la API de Gemini
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }]}],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    });
    
    const raw = result.response.text();
    let extracted: any;
    try { extracted = JSON.parse(raw); } catch { extracted = { _raw: raw, parseError: 'JSON_PARSE_FAIL' }; }

    // 6. Formatear la respuesta
    extracted = {
      title: data.title || null,
      url,
      images,
      ...extracted,
    };

    return { status: 200, body: { ok: true, url, model: modelName, extracted } };
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || 'AXIOS_ERROR';
      return {
        status: status >= 400 && status < 600 ? status : 500,
        body: { ok: false, error: code, message: err.message, details: err.response?.data },
      };
    }
    return { status: 500, body: { ok: false, error: 'GEMINI_ERROR', message: String(err?.message || err) } };
  }
}

// ----------------------------------------------------------------------------------
// 📄 FUNCIÓN 3: ChatPDF (Subir por URL y extraer contenido via prompt)
// ----------------------------------------------------------------------------------

export async function extractFromPdfUrl(query: any): Promise<ScrapeResult> {
  if ((query?.mode || '').toString() === 'embedded-wasm') {
    try {
      // Lazy load MuPDF WASM. If not installed/initialized, return a guided error.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mupdf = require('mupdf');
      if (!mupdf) {
        return {
          status: 500,
          body: {
            ok: false,
            error: 'MUPDF_NOT_AVAILABLE',
            message: 'MuPDF WASM package not available. Install the npm package and retry.',
            details: { install: 'pnpm add mupdf' },
          },
        };
      }
      return {
        status: 501,
        body: {
          ok: false,
          error: 'MUPDF_NOT_IMPLEMENTED',
          message: 'embedded-wasm extraction path scaffolded. Implementation requires wiring MuPDF API to enumerate embedded images.',
        },
      };
    } catch (e: any) {
      return {
        status: 500,
        body: {
          ok: false,
          error: 'MUPDF_NOT_AVAILABLE',
          message: 'MuPDF WASM package not available. Install the npm package and retry.',
          details: { install: 'pnpm add mupdf', cause: String(e?.message || e) },
        },
      };
    }
  }
  const pdfUrl = query?.url || query?.pdfUrl;
  if (!pdfUrl || typeof pdfUrl !== 'string') {
    return { status: 400, body: { ok: false, error: 'INVALID_PDF_URL', message: 'Provide query.url with a valid PDF URL' } };
  }
  try {
    const u = new URL(pdfUrl);
    const res = await axios.get<ArrayBuffer>(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: env.scrapeTimeoutMs,
      maxContentLength: env.scrapeMaxBytes,
      maxBodyLength: env.scrapeMaxBytes,
      headers: {
        'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': `${u.protocol}//${u.host}/`,
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const contentType = String((res.headers as any)['content-type'] || '');
    if (!/application\/(pdf|octet-stream)/i.test(contentType)) {
      return {
        status: 403,
        body: {
          ok: false,
          error: 'PDF_FETCH_FORBIDDEN',
          message: 'The server did not return a PDF (possibly blocked or requires headers).',
          details: { status: (res as any).status, contentType },
        },
      };
    }
    const buffer = Buffer.from(res.data as ArrayBuffer);
    const parsed = await pdfParse(buffer);
    let images: string[] = [];

    if ((query?.mode || '').toString() === 'embedded') {
      try {
        const storageRoot = path.resolve('storage');
        const id = `pdf_${Date.now()}`;
        const outDir = path.join(storageRoot, id);
        await fs.mkdir(outDir, { recursive: true });
        const pdfPath = path.join(outDir, 'input.pdf');
        await fs.writeFile(pdfPath, buffer);

        const files = await extractEmbeddedImagesToDir(buffer, outDir);
        const urls = files.map((f) => `/static/${id}/${f}`);
        return {
          status: 200,
          body: {
            ok: true,
            url: pdfUrl,
            extracted: {
              text: parsed.text || '',
              numpages: (parsed as any).numpages,
              info: (parsed as any).info,
              metadata: (parsed as any).metadata,
              version: (parsed as any).version,
              pdf: `/static/${id}/input.pdf`,
              images: urls,
            },
          },
        };
      } catch (e: any) {
        if (String(e?.message) === 'PDFIMAGES_NOT_AVAILABLE') {
          return {
            status: 500,
            body: {
              ok: false,
              error: 'PDFIMAGES_NOT_AVAILABLE',
              message: 'The pdfimages CLI (Poppler) is not installed or not in PATH.',
              details: { install: 'sudo dnf install -y poppler-utils' },
            },
          };
        }
        images = [];
      }
    } else {
      try {
        // Lazy load pdfjs for page rendering fallback
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        (pdfjsLib as any).GlobalWorkerOptions.workerSrc = require('pdfjs-dist/legacy/build/pdf.worker.js');
        const pdfjsDistPath = path.dirname(require.resolve('pdfjs-dist/package.json'));
        const standardFontDataUrl = pdfjsDistPath + '/standard_fonts/';
        const cMapUrl = pdfjsDistPath + '/cmaps/';
        const data = new Uint8Array(buffer);
        const loadingTask: any = (pdfjsLib as any).getDocument({
          data,
          standardFontDataUrl,
          cMapUrl,
          cMapPacked: true,
        });
        const pdf = await loadingTask.promise;
        const maxPages = typeof query?.maxPages === 'number' ? Math.max(1, Math.floor(query.maxPages)) : pdf.numPages;
        for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const ctx = canvas.getContext('2d');
          const renderContext = { canvasContext: ctx as any, viewport } as any;
          await page.render(renderContext).promise;
          images.push(canvas.toDataURL('image/png'));
        }
      } catch {
        images = [];
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        url: pdfUrl,
        extracted: {
          text: parsed.text || '',
          numpages: (parsed as any).numpages,
          info: (parsed as any).info,
          metadata: (parsed as any).metadata,
          version: (parsed as any).version,
          images,
        },
      },
    };
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || 'AXIOS_ERROR';
      return {
        status: status >= 400 && status < 600 ? status : 500,
        body: { ok: false, error: code, message: err.message, details: err.response?.data },
      };
    }
    return { status: 500, body: { ok: false, error: 'PDF_EXTRACT_ERROR', message: String(err?.message || err) } };
  }
}