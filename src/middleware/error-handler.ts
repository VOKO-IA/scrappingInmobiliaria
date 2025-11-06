import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

export interface AppError extends Error {
  status?: number;
  code?: string;
  details?: any;
}

/**
 * Middleware centralizado para manejo de errores
 */
export function errorHandler(
  error: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  console.error('Error occurred:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    query: req.query,
    body: req.body,
  });

  // Si ya se envió una respuesta, delegar al handler por defecto de Express
  if (res.headersSent) {
    return next(error);
  }

  // Manejo específico de errores de Axios
  if (axios.isAxiosError(error)) {
    const status = error.response?.status || 500;
    const code = error.code || 'AXIOS_ERROR';
    
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: code,
      message: error.message,
      details: error.response?.data,
    });
  }

  // Errores con código de estado específico
  if (error.status && error.status >= 400 && error.status < 600) {
    return res.status(error.status).json({
      ok: false,
      error: error.code || 'CLIENT_ERROR',
      message: error.message,
      details: error.details,
    });
  }

  // Errores de validación (Zod u otros)
  if (error.message.includes('validation') || error.name === 'ZodError') {
    return res.status(400).json({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: error.details || error.message,
    });
  }

  // Errores de timeout
  if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
    return res.status(408).json({
      ok: false,
      error: 'TIMEOUT_ERROR',
      message: 'Request timeout',
    });
  }

  // Error genérico del servidor
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : error.message,
  });
}

/**
 * Middleware para capturar errores asíncronos
 */
export function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<any>
) {
  return (req: T, res: U, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
