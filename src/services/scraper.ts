/**
 * @deprecated Este archivo está deprecated. 
 * Usar los nuevos servicios modularizados en /services/extraction.ts
 * 
 * - ExtractionService: Servicio principal
 * - WebScraperService: Solo scraping
 * - GeminiService: Solo análisis con AI
 */

import axios from 'axios';
import { load } from 'cheerio';
import { z } from 'zod';
import { isBlockedHost } from '../utils/net';
import { env } from '../config/env';
import { GoogleGenerativeAI } from '@google/generative-ai';
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



// ----------------------------------------------------------------------------------
// 🤖 Análisis de PDF con Gemini (texto + imágenes) y generación de reporte PDF
// ----------------------------------------------------------------------------------





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

