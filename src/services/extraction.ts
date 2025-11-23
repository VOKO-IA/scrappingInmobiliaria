import { WebScraperService } from './web-scraper';
import { GeminiService } from './gemini';
import { UrlQuerySchema } from '../schemas/validation';
import { 
  ApiResponse, 
  PropertyExtraction, 
  ScrapeSuccessResponse, 
  ScrapeErrorResponse, 
  ExtractionSuccessResponse, 
  ExtractionErrorResponse 
} from '../types/scraping';

export class ExtractionService {
  private webScraper: WebScraperService;
  private geminiService: GeminiService;
  // Timeout máximo por solicitud (ms)
  private readonly REQUEST_TIMEOUT_MS = 180_000;

  constructor() {
    this.webScraper = new WebScraperService();
    this.geminiService = new GeminiService();
  }

  // Utilidad para limitar tiempo máximo por operación
  private async withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
    let timeoutId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(tag)), ms);
    });
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      return result as T;
    } finally {
      clearTimeout(timeoutId);
    }
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
            message: 'URL de entrada no válida',
            details: validation.error.flatten(),
            solution: 'Por favor, verifica que la URL sea correcta y esté completa.'
          } as ExtractionErrorResponse,
        };
      }

      const { url } = validation.data;

      // 2. Realizar scraping de la página web (con timeout)
      const scrapedData = await this.withTimeout(this.webScraper.scrapeUrl(url), this.REQUEST_TIMEOUT_MS, 'SCRAPE_TIMEOUT');

      // 3. Extraer información usando Gemini AI (con timeout)
      const extractedData = await this.withTimeout(this.geminiService.extractPropertyInfo(url, scrapedData), this.REQUEST_TIMEOUT_MS, 'GEMINI_TIMEOUT');

      // 4. Retornar respuesta exitosa
      return {
        status: 200,
        body: {
          ok: true,
          url,
          model: this.geminiService.getModelName(),
          extracted: extractedData,
        } as ExtractionSuccessResponse,
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
            message: 'URL de entrada no válida',
            details: validation.error.flatten(),
            solution: 'Por favor, verifica que la URL sea correcta y esté completa.'
          } as ScrapeErrorResponse,
        };
      }

      const { url } = validation.data;

      // 2. Realizar scraping de la página web (con timeout)
      const scrapedData = await this.withTimeout(this.webScraper.scrapeUrl(url), this.REQUEST_TIMEOUT_MS, 'SCRAPE_TIMEOUT');

      // 3. Retornar datos scrapeados
      return {
        status: 200,
        body: {
          ok: true,
          url,
          data: scrapedData,
        } as ScrapeSuccessResponse,
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
    console.error('Error en handleError:', error);

    // Timeout de solicitud total
    if (errorMessage.includes('SCRAPE_TIMEOUT') || errorMessage.includes('GEMINI_TIMEOUT')) {
      return {
        status: 504,
        body: {
          ok: false,
          error: 'REQUEST_TIMEOUT',
          message: 'La operación excedió el tiempo máximo permitido',
          solution: 'Intenta nuevamente más tarde o reduce la complejidad del contenido.'
        }
      };
    }

    // Errores Puppeteer comunes
    if (/PUPPETEER_PROTOCOL_TIMEOUT|Navigation timeout|ProtocolError/i.test(errorMessage)) {
      return {
        status: 504,
        body: {
          ok: false,
          error: 'BROWSER_TIMEOUT',
          message: 'El navegador tardó demasiado en renderizar la página',
          solution: 'Intenta nuevamente. Se aumentaron los tiempos de espera, pero algunas páginas requieren más tiempo.'
        }
      };
    }

    // Errores específicos del scraper
    if (errorMessage.includes('UNSUPPORTED_PROTOCOL')) {
      return {
        status: 400,
        body: { 
          ok: false, 
          error: 'UNSUPPORTED_PROTOCOL', 
          message: 'Solo se permiten protocolos HTTP y HTTPS',
          solution: 'Asegúrate de que la URL comience con http:// o https://'
        },
      };
    }

    if (errorMessage.includes('BLOCKED_HOST') || errorMessage.includes('BLOCKED_PRIVATE_IP')) {
      return {
        status: 400,
        body: { 
          ok: false, 
          error: 'BLOCKED_HOST', 
          message: 'El host está bloqueado o es una dirección IP privada',
          solution: 'No se pueden acceder a hosts bloqueados o direcciones IP privadas'
        },
      };
    }

    if (errorMessage.includes('BLOCKED_BY_ANTIBOT')) {
      return {
        status: 429,
        body: {
          ok: false,
          error: 'ANTI_BOT_DETECTED',
          message: 'El sitio web ha detectado actividad automatizada',
          solution: 'Intenta de nuevo más tarde o usa un servicio de proxy'
        }
      };
    }

    if (errorMessage.includes('DNS_RESOLUTION_FAILED')) {
      return {
        status: 400,
        body: { 
          ok: false, 
          error: 'DNS_RESOLUTION_FAILED', 
          message: 'No se pudo resolver el nombre de dominio',
          solution: 'Verifica que la URL sea correcta y que tengas conexión a internet'
        },
      };
    }

    // Errores HTTP
    if (errorMessage.includes('HTTP_ERROR')) {
      const [, details] = errorMessage.split('HTTP_ERROR: ');
      
      // Detectar códigos de estado comunes
      if (details.includes('STATUS_403')) {
        return {
          status: 403,
          body: {
            ok: false,
            error: 'FORBIDDEN',
            message: 'Acceso denegado por el servidor',
            details: 'El servidor ha rechazado la solicitud (403 Forbidden)',
            solution: 'El sitio web puede estar bloqueando solicitudes automatizadas. Intenta con un User-Agent diferente o un servicio de proxy.'
          }
        };
      }
      
      if (details.includes('STATUS_404')) {
        return {
          status: 404,
          body: {
            ok: false,
            error: 'NOT_FOUND',
            message: 'La página no existe (404)',
            solution: 'Verifica que la URL sea correcta y que la página aún esté disponible'
          }
        };
      }
      
      if (details.includes('STATUS_429')) {
        return {
          status: 429,
          body: {
            ok: false,
            error: 'TOO_MANY_REQUESTS',
            message: 'Demasiadas solicitudes',
            solution: 'El sitio web está limitando las solicitudes. Espera unos minutos antes de intentar nuevamente.'
          }
        };
      }

      // Error HTTP genérico
      return {
        status: 500,
        body: { 
          ok: false, 
          error: 'HTTP_ERROR', 
          message: `Error en la solicitud HTTP: ${details || 'Error desconocido'}`,
          solution: 'Verifica tu conexión a internet y que el sitio web esté disponible'
        },
      };
    }

    // Errores de timeout
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return {
        status: 504,
        body: {
          ok: false,
          error: 'REQUEST_TIMEOUT',
          message: 'La solicitud ha excedido el tiempo de espera',
          solution: 'El servidor está tardando demasiado en responder. Intenta de nuevo más tarde o verifica tu conexión a internet.'
        }
      };
    }

    // Errores de Gemini
    if (errorMessage.includes('GEMINI_API_KEY is required')) {
      return {
        status: 500,
        body: { 
          ok: false, 
          error: 'MISSING_GEMINI_API_KEY', 
          message: 'No se ha configurado la clave de API de Gemini',
          solution: 'Asegúrate de configurar la variable de entorno GEMINI_API_KEY'
        },
      };
    }

    if (/reported as leaked/i.test(errorMessage)) {
      return {
        status: 500,
        body: {
          ok: false,
          error: 'GEMINI_API_KEY_LEAKED',
          message: 'La clave de la API de Gemini fue marcada como expuesta',
          solution: 'Rotar la clave en Google AI Studio y actualizar GEMINI_API_KEY en el servidor.'
        }
      };
    }

    if (errorMessage.includes('Gemini extraction failed')) {
      return {
        status: 500,
        body: { 
          ok: false, 
          error: 'GEMINI_ERROR', 
          message: 'Error al procesar la información con Gemini AI',
          details: errorMessage,
          solution: 'Verifica que la API de Gemini esté funcionando correctamente y que la respuesta del sitio web sea válida'
        },
      };
    }

    // Error genérico
    return {
      status: 500,
      body: { 
        ok: false, 
        error: 'INTERNAL_ERROR', 
        message: 'Error interno del servidor',
        details: errorMessage,
        solution: 'Por favor, intenta de nuevo más tarde. Si el problema persiste, contacta al soporte técnico.'
      },
    };
  }
}
