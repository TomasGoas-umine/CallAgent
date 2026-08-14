/**
 * Helpers de respuesta HTTP en formato APIGatewayProxyStructuredResultV2, para que los handlers
 * devuelvan siempre el mismo shape sin importar si corren detras de API Gateway HTTP v2 real
 * o del servidor Fastify local (src/local/server.ts adapta este shape de vuelta a HTTP).
 */

export interface ApiResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

export function jsonResponse(statusCode: number, payload: unknown): ApiResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export const ok = (payload: unknown): ApiResponse => jsonResponse(200, payload);
export const created = (payload: unknown): ApiResponse => jsonResponse(201, payload);
export const badRequest = (message: string): ApiResponse => jsonResponse(400, { error: message });
export const unauthorized = (message: string): ApiResponse => jsonResponse(401, { error: message });
export const notFound = (message: string): ApiResponse => jsonResponse(404, { error: message });
export const serverError = (message: string): ApiResponse => jsonResponse(500, { error: message });
