/**
 * Dominio: Candidato de llamada.
 *
 * Un "candidato" es un registro del Semaforo (tablero-api) que, tras pasar por el
 * urgency-classifier, calza con el unico caso de uso del MVP:
 * Seccion A - Riesgo Conexion - nivel CRITICO.
 *
 * OJO: el campo `phone` NO existe en el dato real del Semaforo (ver docs/context/PROJECT_CONTEXT.md
 * y la auditoria de tablero-api resumida ahi). En este MVP solo se usa via FixtureTableroApiClient,
 * con un campo marcado explicitamente como `phone_test_only`.
 */

export type UrgencyLevel = 'NORMAL' | 'ALERTA' | 'CRITICO';

export type CourseWeek = 1 | 2 | 3 | 4;

/** Registro tal como lo entrega (o entregaria) GET /tablero/search — por alumno, no agregado. */
export interface TableroRecord {
  client_name: string;
  client_id: string;
  course_name: string;
  order_number: string;
  init_course: string;
  end_course: string;
  rut: string;
  sence_connections: number;
  /** Cantidad de inscritos del curso — necesaria para calcular pct_conexion. */
  enrolled_count: number;
  order_status: string;
  student_email: string;
  first_name: string;
  last_name: string;
  updated_at: string;
  /**
   * Dato SINTETICO de prueba, no existe en produccion. Nunca debe usarse fuera de
   * TABLERO_API_MODE=fixture. Ver DECISIONS.md ADR-004.
   */
  phone_test_only?: string;
  /**
   * Contacto del curso — tambien SINTETICO (tablero-api no lo expone). En el fixture van
   * prefijados con `TEST ·` a proposito: hay cursos con nombre de cliente real y un nombre de
   * persona inventado sin marca podria leerse como dato real. El cargo NO resuelve la pregunta
   * abierta UV-023 (a quien se llama): es solo relleno para poder mostrar la columna.
   */
  contacto_nombre?: string;
  contacto_cargo?: string;
}

export interface TableroSearchFilters {
  seccion?: 'A_RIESGO_CONEXION';
  order_status?: string;
}

/** Candidato ya evaluado: registro + clasificacion + metadatos de decision. */
export interface EvaluatedCandidate {
  record: TableroRecord;
  semana: CourseWeek;
  pctConexion: number;
  nivel: UrgencyLevel;
  promotedOrderStatus: string;
  idempotencyKey: string;
}

export interface DiscardedCandidate {
  record: TableroRecord;
  motivo:
    | 'sin_telefono'
    | 'do_not_call'
    | 'duplicado'
    | 'cooldown'
    | 'no_critico'
    | 'oc_internacional'
    | 'estado_excluido';
}
