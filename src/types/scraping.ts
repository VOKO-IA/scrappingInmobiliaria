// Tipos para el sistema de scraping y extracción

export interface ImageData {
  src?: string;
  absSrc?: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  loading?: string;
  decoding?: string;
  referrerPolicy?: string;
  crossorigin?: string;
  sizes?: string;
  srcset: Array<{ url: string; descriptor?: string }>;
}

export interface FigureData {
  caption: string;
  images: ImageData[];
}

export interface ScrapedData {
  title: string;
  text: string;
  charCount: number;
  wordCount: number;
  images: ImageData[];
  figures: FigureData[];
}

export interface PropertyExtraction {
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
}

export interface ScrapeResponse {
  ok: boolean;
  status?: number;
  url?: string;
  data?: ScrapedData;
  message?: string;
  error?: string;
  details?: any;
}

export interface ExtractionResponse {
  ok: boolean;
  url?: string;
  model?: string;
  extracted?: PropertyExtraction;
  message?: string;
  error?: string;
  details?: any;
}

export interface ApiResponse {
  status: number;
  body: ScrapeResponse | ExtractionResponse;
}
