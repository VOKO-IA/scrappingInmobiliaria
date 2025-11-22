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
   * Realiza la petición HTTP a la URL
   */
  private async fetchPage(url: string) {
    const urlObj = new URL(url);
    const isInmuebles24 = urlObj.hostname.includes('inmuebles24.com');

    // Usar un User-Agent móvil por defecto para inmuebles24
    const desktopUA = isInmuebles24 
      ? 'Mozilla/5.0 (Linux; Android 10; SM-A505F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : WebScraperService.USER_AGENTS[
          Math.floor(Math.random() * WebScraperService.USER_AGENTS.length)
        ];

    const baseHeaders: Record<string, string> = {
      'User-Agent': desktopUA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8,en-US;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'max-age=0',
      'DNT': '1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };

    if (isInmuebles24) {
      // Headers específicos para inmuebles24
      baseHeaders['Referer'] = 'https://www.google.com/';
      baseHeaders['Sec-Fetch-Site'] = 'cross-site';
      // Agregar cookies comunes
      baseHeaders['Cookie'] = 'cookieConsent=true; _ga=GA1.1.1234567890.1234567890; _gid=GA1.1.1234567890.1234567890';
    }

    const attempt = async (headers: Record<string, string>, isRetry = false) => {
      try {
        // Agregar un pequeño retraso aleatorio entre 1-3 segundos para inmuebles24
        if (isInmuebles24) {
          const delay = 1000 + Math.random() * 2000; // 1-3 segundos
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const resp = await axios.get<string>(url, {
          timeout: isInmuebles24 ? 30000 : env.scrapeTimeoutMs, // 30 segundos para inmuebles24
          maxRedirects: 5,
          maxContentLength: env.scrapeMaxBytes,
          maxBodyLength: env.scrapeMaxBytes,
          headers: {
            ...headers,
            // Rotar User-Agent ligeramente en cada intento
            'User-Agent': isRetry && !isInmuebles24 
              ? WebScraperService.MOBILE_UA 
              : headers['User-Agent']
          },
          responseType: 'text',
          validateStatus: () => true,
        });

        // Si es inmuebles24 y detectamos una página de bloqueo, lanzar error
        if (isInmuebles24 && 
            (resp.data.includes('distil_r_block') || 
             resp.data.includes('Access Denied') ||
             resp.status === 403)) {
          throw new Error('BLOCKED_BY_ANTIBOT');
        }

        return resp;
      } catch (error) {
        if (axios.isAxiosError(error) && !error.response && !isRetry) {
          // Si es un error de red y no es un reintento, esperar un poco y reintentar
          await new Promise(resolve => setTimeout(resolve, 2000));
          return attempt(headers, true);
        }
        throw error;
      }
    };

    // 1) Intento con UA de escritorio
    let response = await attempt(baseHeaders);

    // 2) Si falla y es inmuebles24, reintentar con UA móvil y mismos headers
    if (isInmuebles24 && (response.status < 200 || response.status >= 400)) {
      const mobileHeaders = { ...baseHeaders, 'User-Agent': WebScraperService.MOBILE_UA };
      response = await attempt(mobileHeaders);
    }

    if (response.status >= 200 && response.status < 400) {
      return response;
    }

    const statusText = response.statusText || 'Request failed';
    const bodyLen = typeof response.data === 'string' ? response.data.length : 0;
    throw new Error(
      `HTTP_ERROR: STATUS_${response.status} - ${statusText} [host=${urlObj.hostname} path=${urlObj.pathname} len=${bodyLen}]`
    );
  }

  /**
   * Procesa el HTML y extrae el contenido estructurado
   */
  private parseHtml(html: string, baseUrl: string): ScrapedData {
    const $ = load(html);

    // Remover elementos no deseados
    $('script,style,noscript,template,svg,canvas,iframe,meta,link,head').remove();

    const title = $('title').first().text().trim();
    
    // Extraer imágenes
    const images = this.extractImages($, baseUrl);
    
    // Extraer figures
    const figures = this.extractFigures($, baseUrl);
    
    // Extraer texto del body
    const bodyTextRaw = $('body').text();
    const text = bodyTextRaw.replace(/\s+/g, ' ').trim();
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
