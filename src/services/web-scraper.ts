import axios, { AxiosRequestConfig } from 'axios';
import { load } from 'cheerio';
import { env } from '../config/env';
import { isBlockedHost } from '../utils/net';
import { ScrapedData, ImageData, FigureData } from '../types/scraping';
import * as https from 'https';
import * as http from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { randomInt, randomFloat } from '../utils/random';
import { performance } from 'perf_hooks';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { executablePath } from 'puppeteer';

// Add type declaration for puppeteer-extra
declare module 'puppeteer-extra' {
  interface PuppeteerExtra {
    use(plugin: any): PuppeteerExtra;
  }
}

// Initialize puppeteer with stealth plugin
puppeteer.use(StealthPlugin());

// Interface for proxy configuration
interface ProxyConfig {
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

export class WebScraperService {
  private static readonly USER_AGENTS = [
    // Desktop
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    
    // Mobile
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    
    // Less common
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ];

  // List of common HTTP headers to rotate
  private static readonly COMMON_HEADERS = [
    {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
      'TE': 'trailers'
    },
    {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'DNT': '1',
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache'
    }
  ];

  // Proxy configuration
  private proxyConfig: ProxyConfig | null = null;
  private proxyList: ProxyConfig[] = [];
  private currentProxyIndex = 0;
  private usePuppeteer = false; // Toggle between axios and puppeteer
  
  // Request timing
  private lastRequestTime = 0;
  private minDelay = 2000; // 2 seconds minimum between requests
  private maxDelay = 10000; // 10 seconds maximum between requests

  private static readonly MIN_DIMENSION_PX = 150;
  
  // Mobile User-Agent constant
  private static readonly MOBILE_UA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

  constructor(usePuppeteer: boolean = false) {
    this.usePuppeteer = usePuppeteer;
    this.initializeProxies();
  }

  /**
   * Initialize proxy configuration if needed
   */
  private initializeProxies(): void {
    // You can load proxies from environment variables or a config file here
    // Example:
    // if (process.env.PROXY_LIST) {
    //   this.proxyList = JSON.parse(process.env.PROXY_LIST);
    //   this.rotateProxy();
    // }
  }

  /**
   * Realiza el scraping de una URL y extrae el contenido
   */
  async scrapeUrl(url: string): Promise<ScrapedData> {
    // Validar protocolo
    const urlObj = new URL(url);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new Error('UNSUPPORTED_PROTOCOL');
    }

    // Verificar si el host está bloqueado
    const blockCheck = await isBlockedHost(urlObj.hostname);
    if (blockCheck.blocked) {
      throw new Error(blockCheck.reason || 'BLOCKED_HOST');
    }

    try {
      // Realizar petición HTTP
      const response = await this.fetchPage(url);
      
      // Procesar HTML con Cheerio
      return this.parseHtml(response.data, url);

    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        const code = error.code || 'AXIOS_ERROR';
        throw new Error(`HTTP_ERROR: ${code} - ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Devuelve el HTML crudo (sin parsear) usando la misma lógica anti-bot.
   */
  public async fetchRawHtml(url: string): Promise<string> {
    const urlObj = new URL(url);
    const realEstateHosts = ['inmuebles24.com', 'vivanuncios.com', 'vivanuncios.com.mx', 'lamudi.com', 'lamudi.com.mx', 'mercadolibre.com', 'mercadolibre.com.mx'];
    const shouldUsePuppeteer = this.usePuppeteer || realEstateHosts.some(h => urlObj.hostname.includes(h));

    if (shouldUsePuppeteer) {
      return await this.fetchWithPuppeteer(url, { allowHeavy: true, extraWaitMs: 5000 });
    }

    const baseUA = WebScraperService.USER_AGENTS[Math.floor(Math.random() * WebScraperService.USER_AGENTS.length)];
    const resp = await axios.get<string>(url, {
      timeout: 120000,
      maxRedirects: 5,
      maxContentLength: env.scrapeMaxBytes,
      maxBodyLength: env.scrapeMaxBytes,
      responseType: 'text',
      headers: {
        'User-Agent': baseUA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      validateStatus: () => true,
    });
    if (resp.status >= 200 && resp.status < 400) {
      // Si huele a antibot aunque sea 200, podemos caer a Puppeteer
      const body = resp.data || '';
      if (/access denied|distil|captcha/i.test(body)) {
        return await this.fetchWithPuppeteer(url, { allowHeavy: true, extraWaitMs: 5000 });
      }
      return body;
    }
    if (resp.status === 403 || resp.status === 429) {
      return await this.fetchWithPuppeteer(url, { allowHeavy: true, extraWaitMs: 5000 });
    }
    throw new Error(`HTTP_ERROR: STATUS_${resp.status}`);
  }

  /**
   * Realiza la petición HTTP a la URL
   */
  private async fetchPage(url: string) {
    const urlObj = new URL(url);

    // Dominios de inmobiliarias: usamos Puppeteer para mayor sigilo
    const realEstateHosts = ['inmuebles24.com', 'vivanuncios.com', 'vivanuncios.com.mx', 'lamudi.com', 'lamudi.com.mx', 'mercadolibre.com', 'mercadolibre.com.mx'];
    const shouldUsePuppeteer = this.usePuppeteer || realEstateHosts.some(h => urlObj.hostname.includes(h));

    // Headers base para Axios
    const baseUA = WebScraperService.USER_AGENTS[Math.floor(Math.random() * WebScraperService.USER_AGENTS.length)];
    const baseHeaders: Record<string, string> = {
      'User-Agent': baseUA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'DNT': '1',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1'
    };

    if (shouldUsePuppeteer) {
      // Para portales inmobiliarios es más estable permitir recursos pesados y esperar un poco más
      const html = await this.fetchWithPuppeteer(url, { allowHeavy: true, extraWaitMs: 5000 });
      return { data: html, status: 200, statusText: 'OK' };
    }

    // Ruta Axios con reintentos/backoff y timeouts más largos
    const maxAttempts = 4; // más reintentos
    let attemptNo = 0;
    let lastError: any;

    while (attemptNo < maxAttempts) {
      try {
        // Pausa humana aleatoria entre 800–2500 ms
        await this.humanPause(800, 2500);

        const resp = await axios.get<string>(url, {
          timeout: 90000, // 90s
          maxRedirects: 5,
          maxContentLength: env.scrapeMaxBytes,
          maxBodyLength: env.scrapeMaxBytes,
          headers: {
            ...baseHeaders,
            'User-Agent': attemptNo === 0 ? baseUA : WebScraperService.MOBILE_UA
          },
          responseType: 'text',
          validateStatus: () => true,
        });

        if (resp.status >= 200 && resp.status < 400) {
          return resp;
        }

        // Fallback: si recibimos 403/anti-bot, probar Puppeteer como último recurso
        if (resp.status === 403 || (typeof resp.data === 'string' && /access denied|distil|captcha/i.test(resp.data))) {
          // último intento: Puppeteer
          const html = await this.fetchWithPuppeteer(url);
          return { data: html, status: 200, statusText: 'OK' };
        }

        lastError = new Error(`HTTP_ERROR_STATUS_${resp.status}`);
      } catch (err: any) {
        lastError = err;
      }

      // Backoff exponencial con jitter
      const base = 800;
      const backoff = Math.min(5000, base * Math.pow(2, attemptNo)) + Math.floor(Math.random() * 400);
      await this.humanPause(backoff, backoff + 600);
      attemptNo++;
    }

    throw lastError || new Error('REQUEST_FAILED');
  }

  // Lanzar Puppeteer con configuración sigilosa
  private async launchPuppeteer(allowHeavy = false) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--lang=es-ES,es',
      '--window-size=1366,768',
    ];

    // Construir opciones de lanzamiento sin forzar executablePath.
    const launchOptions: any = {
      headless: 'new',
      args,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1366 + Math.floor(Math.random() * 120),
        height: 768 + Math.floor(Math.random() * 120),
        deviceScaleFactor: 1,
        hasTouch: Math.random() < 0.2,
        isLandscape: false,
        isMobile: false,
      },
    };

    // 1) Si el entorno define PUPPETEER_EXECUTABLE_PATH, úsalo.
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      // 2) Intenta obtener executablePath() y si falla, lo omitimos para que Puppeteer resuelva por defecto.
      try {
        const ep = executablePath();
        if (ep) launchOptions.executablePath = ep;
      } catch {
        // Sin executablePath explícito. Puppeteer intentará usar su Chromium instalado.
      }
    }

    const browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    // Aumentar timeouts por defecto
    try {
      page.setDefaultTimeout(120000); // 120s para waitFor*
      page.setDefaultNavigationTimeout(210000); // 210s navegación
    } catch {}

    // UA y headers realistas
    await page.setUserAgent(WebScraperService.USER_AGENTS[Math.floor(Math.random() * WebScraperService.USER_AGENTS.length)]);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    });

    // Intercepción para bloquear recursos pesados (si no se permite heavy)
    if (!allowHeavy) {
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        const type = req.resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) return req.abort();
        req.continue();
      });
    }

    return { browser, page };
  }

  // Obtener HTML con comportamiento humano
  private async fetchWithPuppeteer(url: string, opts?: { allowHeavy?: boolean; extraWaitMs?: number }): Promise<string> {
    const allowHeavy = !!opts?.allowHeavy;
    const extraWaitMs = opts?.extraWaitMs ?? 0;
    const { browser, page } = await this.launchPuppeteer(allowHeavy);
    const run = async (): Promise<string> => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      // Esperar calma de red después del DOM cargado
      try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }); } catch {}

      // Intentar aceptar cookies comunes
      try {
        await new Promise(r => setTimeout(r, 600));
        await this.safeEvaluate(page, () => {
          const byId = document.getElementById('onetrust-accept-btn-handler');
          if (byId) (byId as HTMLButtonElement).click();
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
          const cand = buttons.find(b => /aceptar|accept/i.test(b.innerText || ''));
          if (cand) cand.click();
        });
      } catch {}

      // Simular actividad humana
      await this.humanPause(800, 1800);
      await this.mouseWiggle(page);
      await this.scrollPage(page, 1500 + Math.floor(Math.random() * 2000));

      // Esperar elementos comunes de listados (si existen)
      try {
        await page.waitForSelector('a, h1, .listing, [role="main"], [itemtype*="schema.org/Offer"], [itemtype*="schema.org/Product"]', { timeout: 7000 });
      } catch {}

      // Evitar capturar intersticiales tipo "Un momento…" (común en Inmuebles24)
      await this.waitForRealContent(page, new URL(url).hostname);

      if (extraWaitMs > 0) {
        await new Promise(r => setTimeout(r, extraWaitMs));
      }

      return await page.content();
    };

    try {
      return await run();
    } catch (err: any) {
      // Reintento único si el contexto fue destruido por navegación
      if (err && /Execution context was destroyed/i.test(String(err.message || err))) {
        try {
          await new Promise(r => setTimeout(r, 600));
          return await run();
        } catch (e) {
          throw e;
        }
      }
      throw err;
    } finally {
      await browser.close();
    }
  }

  private async scrollPage(page: any, durationMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < durationMs) {
      try {
        await this.safeEvaluate(page, (delta: number) => window.scrollBy(0, delta), 100 + Math.floor(Math.random() * 200));
      } catch {}
      await this.humanPause(120, 320);
    }
    // subir un poco
    try { await this.safeEvaluate(page, () => window.scrollBy(0, -200)); } catch {}
  }

  private async mouseWiggle(page: any) {
    try {
      const x = 50 + Math.floor(Math.random() * 400);
      const y = 50 + Math.floor(Math.random() * 300);
      // @ts-ignore
      if (page.mouse && page.mouse.move) {
        // @ts-ignore
        await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 6) });
      }
    } catch {}
  }

  private async humanPause(minMs: number, maxMs: number) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    await new Promise(r => setTimeout(r, ms));
  }

  // Evalúa en la página con reintentos ante 'Execution context was destroyed'
  private async safeEvaluate(page: any, fn: any, ...args: any[]) {
    const max = 3;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await page.evaluate(fn, ...args);
      } catch (err: any) {
        const msg = String(err?.message || err);
        const transient = /Execution context was destroyed|Cannot find context|Target closed/i.test(msg);
        if (transient && attempt < max) {
          attempt++;
          await new Promise(r => setTimeout(r, 250));
          continue;
        }
        throw err;
      }
    }
  }

  // Espera hasta que haya contenido real (evita pantallas intermedias tipo "Un momento…")
  private async waitForRealContent(page: any, hostname: string) {
    const isI24 = /inmuebles24\.com/i.test(hostname);
    const deadline = Date.now() + 25000; // hasta 25s
    let reloaded = false;

    while (Date.now() < deadline) {
      const state = await this.safeEvaluate(page, () => ({
        title: document.title || '',
        bodyLen: (document.querySelector('body')?.innerText || '').trim().length,
      }));

      const looksInterstitial = /un momento|checking your browser|verificando|please wait/i.test(state.title);
      const enoughBody = state.bodyLen > 1200; // contenido razonable

      if ((!looksInterstitial || !isI24) && enoughBody) return;

      // Intentar una recarga si seguimos en intersticial
      if (isI24 && looksInterstitial && !reloaded) {
        try {
          await page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch {}
        reloaded = true;
      }

      await this.humanPause(400, 900);
      try { await this.scrollPage(page, 600); } catch {}
    }
  }

  /**
   * Procesa el HTML y extrae el contenido estructurado
   */
  private parseHtml(html: string, baseUrl: string): ScrapedData {
    const $ = load(html);

    // Capturar el título ANTES de limpiar el DOM y evitar eliminar el head
    const title = $('title').first().text().trim();

    // Capturar JSON-LD antes de eliminar <script> (muchos portales inmobiliarios lo usan)
    const jsonLdRaw: string = $('script[type="application/ld+json"]').map((_: any, el: any) => {
      return (el && el.children && el.children[0] && (el.children[0] as any).data) || '';
    }).get().filter(Boolean).join('\n');

    // Capturar Next.js __NEXT_DATA__ si existe (SSR/SPA)
    const nextDataRaw: string = $('#__NEXT_DATA__').map((_: any, el: any) => {
      return (el && el.children && el.children[0] && (el.children[0] as any).data) || '';
    }).get().filter(Boolean).join('\n');

    // Capturar metas OpenGraph/SEO relevantes
    const metaSnippets: string[] = [];
    $('meta[property^="og:"], meta[name^="og:"], meta[name="description"], meta[property="article:published_time"]').each((_: any, el: any) => {
      const name = $(el).attr('property') || $(el).attr('name') || '';
      const content = ($(el).attr('content') || '').trim();
      if (name && content) metaSnippets.push(`${name}: ${content}`);
    });

    // Remover elementos no deseados (pero conservamos <head> para no perder el título)
    $('script,style,noscript,template,svg,canvas,iframe,meta,link').remove();
    
    // Extraer imágenes
    const images = this.extractImages($, baseUrl);
    
    // Extraer figures
    const figures = this.extractFigures($, baseUrl);
    
    // Extraer texto del body
    const bodyTextRaw = $('body').text();
    let text = bodyTextRaw.replace(/\s+/g, ' ').trim();

    // Adjuntar JSON-LD para enriquecer el contexto del extractor
    if (jsonLdRaw) {
      const trimmedLd = jsonLdRaw.slice(0, 50000);
      text = `${text}\n${trimmedLd}`.trim();
    }

    // Adjuntar __NEXT_DATA__ si está presente
    if (nextDataRaw) {
      const trimmedNext = nextDataRaw.slice(0, 50000);
      text = `${text}\n${trimmedNext}`.trim();
    }

    // Adjuntar metas relevantes
    if (metaSnippets.length) {
      const metasJoined = metaSnippets.join('\n').slice(0, 2000);
      text = `${text}\n${metasJoined}`.trim();
    }
    const wordCount = text ? text.split(/\s+/).length : 0;

    return {
      title,
      text,
      charCount: text.length,
      wordCount,
      images,
      figures,
    };
  }

  /**
   * Extrae información de imágenes del HTML
   */
  private extractImages($: any, baseUrl: string): ImageData[] {
    return $('img')
      .map((_: any, el: any) => {
        const $el = $(el);
        const imageData = this.processImageElement($el, baseUrl);
        return this.isValidImage(imageData) ? imageData : undefined;
      })
      .get()
      .filter(Boolean);
  }

  /**
   * Extrae información de figures del HTML
   */
  private extractFigures($: any, baseUrl: string): FigureData[] {
    return $('figure')
      .map((_: any, el: any) => {
        const $fig = $(el);
        const caption = $fig.find('figcaption').text().replace(/\s+/g, ' ').trim();
        
        const figImages = $fig
          .find('img')
          .map((__: any, img: any) => {
            const $img = $(img);
            const imageData = this.processImageElement($img, baseUrl);
            return this.isValidImage(imageData) ? imageData : undefined;
          })
          .get()
          .filter(Boolean);

        return { caption, images: figImages };
      })
      .get();
  }

  /**
   * Procesa un elemento de imagen individual
   */
  private processImageElement($el: any, baseUrl: string): ImageData {
    const src = $el.attr('src')?.trim();
    const absSrc = this.resolveUrl(src, baseUrl);
    const srcsetRaw = $el.attr('srcset')?.trim();
    const alt = $el.attr('alt')?.trim();
    const title = $el.attr('title')?.trim();
    const loading = $el.attr('loading')?.trim();
    const decoding = $el.attr('decoding')?.trim();
    const widthAttr = Number($el.attr('width')) || undefined;
    const heightAttr = Number($el.attr('height')) || undefined;
    const style = $el.attr('style')?.trim();
    const widthStyle = this.cssPx(style, 'width');
    const heightStyle = this.cssPx(style, 'height');
    const width = widthAttr ?? widthStyle;
    const height = heightAttr ?? heightStyle;
    const referrerpolicy = $el.attr('referrerpolicy')?.trim();
    const crossorigin = $el.attr('crossorigin')?.trim();
    const sizes = $el.attr('sizes')?.trim();

    const srcsetParsed = this.parseSrcSet(srcsetRaw, baseUrl).filter(
      (e) => !this.isSvgUrl(e.url)
    );

    return {
      src: src || undefined,
      absSrc,
      alt,
      title,
      width,
      height,
      loading,
      decoding,
      referrerPolicy: referrerpolicy,
      crossorigin,
      sizes,
      srcset: srcsetParsed,
    };
  }

  /**
   * Valida si una imagen es válida para incluir
   */
  private isValidImage(imageData: ImageData): boolean {
    const { width, height, absSrc, srcset } = imageData;

    // Verificar dimensiones mínimas
    if (
      (width !== undefined && width <= WebScraperService.MIN_DIMENSION_PX) ||
      (height !== undefined && height <= WebScraperService.MIN_DIMENSION_PX)
    ) {
      return false;
    }

    // Verificar si es SVG
    if (absSrc && this.isSvgUrl(absSrc)) {
      return false;
    }

    // Debe tener al menos una URL válida
    return !!(absSrc || srcset.length > 0);
  }

  /**
   * Resuelve URLs relativas a absolutas
   */
  private resolveUrl(maybeUrl?: string, baseUrl?: string): string | undefined {
    if (!maybeUrl || !baseUrl) return undefined;
    try {
      return new URL(maybeUrl, baseUrl).toString();
    } catch {
      return undefined;
    }
  }

  /**
   * Parsea el atributo srcset
   */
  private parseSrcSet(raw?: string, baseUrl?: string): Array<{ url: string; descriptor?: string }> {
    if (!raw) return [];
    
    return raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((part) => {
        const [u, d] = part.split(/\s+/, 2);
        const abs = this.resolveUrl(u, baseUrl);
        return abs ? { url: abs, descriptor: d } : undefined;
      })
      .filter(Boolean) as Array<{ url: string; descriptor?: string }>;
  }

  /**
   * Verifica si una URL es de SVG
   */
  private isSvgUrl(url?: string): boolean {
    if (!url) return false;
    const s = url.toLowerCase();
    return s.startsWith('data:image/svg+xml') || /\.svg(?:$|[?#])/.test(s) || s.includes('image/svg+xml');
  }

  /**
   * Extrae valores en píxeles de CSS
   */
  private cssPx(style?: string, prop?: string): number | undefined {
    if (!style || !prop) return undefined;
    const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`, 'i'));
    return m ? Number(m[1]) : undefined;
  }
}
