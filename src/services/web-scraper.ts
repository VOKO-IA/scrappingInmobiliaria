import axios from 'axios';
import { load } from 'cheerio';
import { env } from '../config/env';
import { isBlockedHost } from '../utils/net';
import { ScrapedData, ImageData, FigureData } from '../types/scraping';

export class WebScraperService {
  private static readonly USER_AGENTS = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  ];

  private static readonly MIN_DIMENSION_PX = 150;

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
    const userAgent = WebScraperService.USER_AGENTS[
      Math.floor(Math.random() * WebScraperService.USER_AGENTS.length)
    ];

    return axios.get<string>(url, {
      timeout: env.scrapeTimeoutMs,
      maxRedirects: 5,
      maxContentLength: env.scrapeMaxBytes,
      maxBodyLength: env.scrapeMaxBytes,
      headers: {
        'User-Agent': userAgent,
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'text',
      validateStatus: (status) => status >= 200 && status < 400,
    });
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
