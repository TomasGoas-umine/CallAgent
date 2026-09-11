/**
 * Guarda arquitectonica: el micrositio de CallAgent NO puede reimplementar la logica del
 * Semaforo.
 *
 * En el ecosistema Umine esa logica ya vive duplicada en dos archivos del repo del Semaforo
 * (`useSenceData.ts` e `InicioBPage.tsx`, marcado riesgo Alto en su propia auditoria). CallAgent
 * agrega una tercera copia inevitable —el adaptador de `src/services/`, que existe solo mientras
 * `tablero-api` no entregue OCs clasificadas— y ninguna cuarta es aceptable.
 *
 * Este test falla si alguien copia umbrales, semanas de curso o filtros de seccion dentro de
 * `web/src`. Todo eso tiene que llegar resuelto por `GET /api/tablero`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function archivosFuente(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return archivosFuente(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Senales de que la logica del Semaforo fue copiada al front, con su explicacion. */
const PROHIBIDO: Array<{ patron: RegExp; que: string }> = [
  { patron: /getCourseWeek|semanaDeCurso|WEEK_THRESHOLDS/i, que: 'calculo de semana de curso' },
  { patron: /clasificarConexion|criticidadDj|nivelStyle/i, que: 'clasificacion de urgencia' },
  {
    patron: /promoteOrderStatus|DEAD_ESTADOS|MANUAL_ESTADOS|INACTIVE_STATUSES/i,
    que: 'promocion/filtrado de order_status',
  },
  {
    patron: /OBTENIENDO DJ|CURSO EN OPERACI|EN EJECUCI/i,
    que: 'estados del Semaforo hardcodeados',
  },
  { patron: /pctConexion\s*[<>]=?\s*\d/, que: 'umbral de porcentaje de conexion' },
  { patron: /\bOPERACI\b|\bEJECUCI\b/, que: 'filtro de seccion A' },
];

describe('web/src no reimplementa la logica del Semaforo', () => {
  const archivos = archivosFuente(SRC);

  it('encuentra archivos que revisar', () => {
    expect(archivos.length).toBeGreaterThan(0);
  });

  for (const { patron, que } of PROHIBIDO) {
    it(`no contiene ${que}`, () => {
      const infractores = archivos
        .filter((f) => {
          // Los comentarios explican POR QUE no se hace; se ignoran para no auto-bloquearse.
          const sinComentarios = readFileSync(f, 'utf-8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          return patron.test(sinComentarios);
        })
        .map((f) => path.relative(SRC, f));

      expect(infractores, `${que} deberia venir de GET /api/tablero, no de web/src`).toEqual([]);
    });
  }
});
