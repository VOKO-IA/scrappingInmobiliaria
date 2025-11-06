import { WebScraperService } from './web-scraper';
import { GeminiService } from './gemini';
import { UrlQuerySchema } from '../schemas/validation';
import { ApiResponse, PropertyExtraction } from '../types/scraping';

export class ExtractionService {
  private webScraper: WebScraperService;
  private geminiService: GeminiService;

  constructor() {
    this.webScraper = new WebScraperService();
    this.geminiService = new GeminiService();
  }

  /**
   * Extrae información de propiedades desde una URL usando scraping + Gemini AI
   */
  async extractFromUrl(query: any): Promise<ApiResponse> {
    try {
      // 1. Validar la URL de entrada
      const validation = UrlQuerySchema.safeParse({ url: query?.url });
      if (!validation.success) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'INVALID_URL',
            details: validation.error.flatten(),
          },
        };
      }

      const { url } = validation.data;

      // 2. Realizar scraping de la página web
      const scrapedData = await this.webScraper.scrapeUrl(url);

      // 3. Extraer información usando Gemini AI
      const extractedData = await this.geminiService.extractPropertyInfo(url, scrapedData);

      // 4. Retornar respuesta exitosa
      return {
        status: 200,
        body: {
          ok: true,
          url,
          model: this.geminiService.getModelName(),
          extracted: extractedData,
        },
      };

    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Solo realiza scraping sin extracción con AI
   */
  async scrapeOnly(query: any): Promise<ApiResponse> {
    try {
      // 1. Validar la URL de entrada
      const validation = UrlQuerySchema.safeParse({ url: query?.url });
      if (!validation.success) {
        return {
          status: 400,
          body: {
            ok: false,
            error: 'INVALID_URL',
            details: validation.error.flatten(),
          },
        };
      }

      const { url } = validation.data;

      // 2. Realizar scraping de la página web
      const scrapedData = await this.webScraper.scrapeUrl(url);

      // 3. Retornar datos scrapeados
      return {
        status: 200,
        body: {
          ok: true,
          url,
          data: scrapedData,
        },
      };

    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * Maneja errores y los convierte en respuestas API apropiadas
   */
  private handleError(error: unknown): ApiResponse {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Errores específicos del scraper
    if (errorMessage.includes('UNSUPPORTED_PROTOCOL')) {
      return {
        status: 400,
        body: { ok: false, error: 'UNSUPPORTED_PROTOCOL', message: 'Only HTTP and HTTPS protocols are supported' },
      };
    }

    if (errorMessage.includes('BLOCKED_HOST') || errorMessage.includes('BLOCKED_PRIVATE_IP')) {
      return {
        status: 400,
        body: { ok: false, error: 'BLOCKED_HOST', message: 'Host is blocked or private' },
      };
    }

    if (errorMessage.includes('DNS_RESOLUTION_FAILED')) {
      return {
        status: 400,
        body: { ok: false, error: 'DNS_RESOLUTION_FAILED', message: 'Could not resolve hostname' },
      };
    }

    // Errores HTTP
    if (errorMessage.includes('HTTP_ERROR')) {
      const [, details] = errorMessage.split('HTTP_ERROR: ');
      return {
        status: 500,
        body: { ok: false, error: 'HTTP_ERROR', message: details || 'HTTP request failed' },
      };
    }

    // Errores de Gemini
    if (errorMessage.includes('GEMINI_API_KEY is required')) {
      return {
        status: 500,
        body: { ok: false, error: 'MISSING_GEMINI_API_KEY', message: 'Gemini API key is not configured' },
      };
    }

    if (errorMessage.includes('Gemini extraction failed')) {
      return {
        status: 500,
        body: { ok: false, error: 'GEMINI_ERROR', message: errorMessage },
      };
    }

    // Error genérico
    return {
      status: 500,
      body: { ok: false, error: 'INTERNAL_ERROR', message: errorMessage },
    };
  }
}
