# Cotizador - Web Scraping & AI Extraction Service

Sistema de extracción de contenido web utilizando scraping tradicional y análisis con Gemini AI para propiedades inmobiliarias.

## 🏗️ Arquitectura

### Estructura del Proyecto

```
src/
├── config/          # Configuración de la aplicación
│   └── env.ts       # Variables de entorno
├── middleware/      # Middlewares de Express
│   └── error-handler.ts  # Manejo centralizado de errores
├── routes/          # Controladores de rutas
│   └── scrape.ts    # Endpoints de scraping y extracción
├── schemas/         # Esquemas de validación
│   └── validation.ts     # Validaciones con Zod
├── services/        # Lógica de negocio
│   ├── extraction.ts     # Servicio principal de extracción
│   ├── gemini.ts         # Servicio de Gemini AI
│   └── web-scraper.ts    # Servicio de scraping web
├── types/           # Definiciones de tipos TypeScript
│   └── scraping.ts       # Tipos para scraping y extracción
├── utils/           # Utilidades
│   └── net.ts            # Utilidades de red
└── app.ts           # Configuración principal de Express
```

## 🚀 Endpoints

### GET `/extract`

Extrae información de propiedades inmobiliarias usando scraping + Gemini AI.

**Query Parameters:**
- `url` (string, required): URL de la propiedad a analizar

**Response:**
```json
{
  "ok": true,
  "url": "https://example.com/property",
  "model": "gemini-1.5-flash",
  "extracted": {
    "title": "Casa en venta",
    "price": 250000,
    "currency": "MXN",
    "address": "Calle Principal 123",
    "city": "Ciudad de México",
    "bedrooms": 3,
    "bathrooms": 2,
    "areaM2": 120,
    "amenities": ["jardín", "cochera"],
    "images": ["url1", "url2"],
    // ... más campos
  }
}
```

### GET `/scrape`

Solo realiza scraping de la página web sin análisis de AI.

**Query Parameters:**
- `url` (string, required): URL a scrapear

**Response:**
```json
{
  "ok": true,
  "url": "https://example.com",
  "data": {
    "title": "Título de la página",
    "text": "Contenido de texto extraído...",
    "charCount": 1500,
    "wordCount": 250,
    "images": [...],
    "figures": [...]
  }
}
```

## ⚙️ Configuración

### Variables de Entorno

Crear un archivo `.env` en la raíz del proyecto:

```env
# Puerto del servidor
PORT=3000

# Configuración de scraping
SCRAPE_TIMEOUT_MS=15000
SCRAPE_MAX_BYTES=2000000

# Gemini AI
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash
```

### Instalación

```bash
npm install
```

### Desarrollo

```bash
npm run dev
```

### Producción

```bash
npm run build
npm start
```

## 🛡️ Características de Seguridad

- **Rate Limiting**: 60 requests por minuto por IP
- **Helmet**: Headers de seguridad HTTP
- **CORS**: Configuración de CORS
- **Host Blocking**: Bloqueo de IPs privadas y localhost
- **Input Validation**: Validación estricta con Zod
- **Error Handling**: Manejo centralizado de errores

## 🔧 Servicios

### WebScraperService

Maneja el scraping de páginas web:
- Extrae contenido HTML
- Procesa imágenes y figures
- Filtra contenido no deseado
- Resuelve URLs relativas

### GeminiService

Integración con Google Gemini AI:
- Análisis de contenido scrapeado
- Extracción estructurada de datos
- Manejo de errores de API
- Configuración de modelos

### ExtractionService

Servicio principal que coordina:
- Validación de entrada
- Orquestación de scraping + AI
- Manejo unificado de errores
- Respuestas estructuradas

## 📝 Tipos de Datos

El sistema utiliza TypeScript con tipos estrictos para:
- `ScrapedData`: Datos extraídos del HTML
- `PropertyExtraction`: Información de propiedades
- `ImageData`: Metadatos de imágenes
- `ApiResponse`: Respuestas de la API

## 🚫 Limitaciones

- Solo soporta protocolos HTTP/HTTPS
- Bloquea IPs privadas y localhost
- Límite de 20 imágenes por extracción
- Timeout de 15 segundos por request
- Máximo 2MB de contenido por página

## 🔍 Monitoreo

El sistema incluye logging con Pino para:
- Requests HTTP
- Errores de aplicación
- Métricas de performance
- Debugging de extracción
