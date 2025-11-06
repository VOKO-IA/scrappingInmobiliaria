import { z } from 'zod';

// Esquema para validar la URL de entrada
export const UrlQuerySchema = z.object({
  url: z.string().url().max(2048)
});

// Esquema para la extracción de propiedades inmobiliarias
export const PropertyExtractionSchema = {
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
  description: 'string|null',
  images: 'string[]',
  url: 'string',
} as const;

export type UrlQuery = z.infer<typeof UrlQuerySchema>;
