import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';
import { PropertyExtraction, ScrapedData } from '../types/scraping';
import { PropertyExtractionSchema } from '../schemas/validation';

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor() {
    if (!env.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required');
    }
    this.genAI = new GoogleGenerativeAI(env.geminiApiKey);
    this.modelName = env.geminiModel || 'gemini-1.5-flash';
  }

  /**
   * Extrae información de propiedades inmobiliarias usando Gemini AI
   */
  async extractPropertyInfo(url: string, scrapedData: ScrapedData): Promise<PropertyExtraction> {
    const model = this.genAI.getGenerativeModel({ model: this.modelName });

    // Preparar las URLs de imágenes
    const images = this.prepareImageUrls(scrapedData);
    
    // Construir el prompt
    const prompt = this.buildExtractionPrompt(url, scrapedData, images);

    try {
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.1, 
          responseMimeType: 'application/json' 
        },
      });

      const rawResponse = result.response.text();
      let extracted: PropertyExtraction;

      try {
        extracted = JSON.parse(rawResponse);
      } catch {
        extracted = { 
          title: scrapedData.title || null,
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
          contactName: env.contactName ||null,
          contactPhone: env.contactPhone || null,
          contactEmail: null,
          description: null,
          images: [],
          url,
          _raw: rawResponse
        };
      }

      // Asegurar que los campos básicos estén presentes
      return {
        ...extracted,
        title: extracted.title || scrapedData.title || null,
        url,
        images: extracted.images?.length > 0 ? extracted.images : images,
        contactName: env.contactName || null,
        contactPhone: env.contactPhone || null,
        contactEmail: null,
      };

    } catch (error) {
      throw new Error(`Gemini extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Prepara las URLs de imágenes desde los datos scrapeados
   */
  private prepareImageUrls(data: ScrapedData): string[] {
    const imageUrls: string[] = [];

    // Extraer URLs de imágenes directas
    if (Array.isArray(data.images)) {
      data.images.forEach(img => {
        if (img.absSrc) imageUrls.push(img.absSrc);
      });
    }

    // Extraer URLs de imágenes en figures
    if (Array.isArray(data.figures)) {
      data.figures.forEach(figure => {
        if (Array.isArray(figure.images)) {
          figure.images.forEach(img => {
            if (img.absSrc) imageUrls.push(img.absSrc);
          });
        }
      });
    }

    // Limitar a 20 imágenes máximo
    return imageUrls.slice(0, 20);
  }

  /**
   * Construye el prompt para la extracción con Gemini
   */
  private buildExtractionPrompt(url: string, data: ScrapedData, images: string[]): string {
    return `You are an information extraction engine. Given the web page text content and image URLs from a real-estate or general product/service page, extract the essential fields and return strictly JSON (no prose). If a field is unknown, use null. Follow this JSON shape and key casing strictly.

JSON shape:
${JSON.stringify(PropertyExtractionSchema, null, 2)}

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
${images.join('\n')}`;
  }

  /**
   * Obtiene el nombre del modelo actual
   */
  getModelName(): string {
    return this.modelName;
  }
}
