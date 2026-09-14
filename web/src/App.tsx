import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Banner } from './components/Banner';
import { TableroMock } from './components/TableroMock';
import { TableroOriginal } from './components/TableroOriginal';
import { Dashboard } from './components/Dashboard';
import { Disparador } from './components/Disparador';
import type {
  CallRules,
  CursoTablero,
  Health,
  LlamadaResumen,
  MockOrderPatch,
  MockTableroResponse,
  SeccionDeVoz,
  TableroOriginalResponse,
} from './types';

type Vista = 'mock' | 'original' | 'dashboard' | 'disparador';

const VISTAS: Array<{ id: Vista; label: string }> = [
  { id: 'mock', label: 'Tablero Mock' },
  { id: 'original', label: 'Tablero Original' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'disparador', label: 'Disparador' },
];

/**
 * Las tres vistas se cambian con estado local, sin router: el micrositio se embebe dentro de un
 * core de Umine y no puede apropiarse de la URL ni depender de rutas absolutas.
 *
 * Los datos se cargan al montar y despues SOLO cuando el operador aprieta Refrescar (o tras un
 * disparo). No hay polling ni intervalos a proposito.
 */
export function App() {
  const [vista, setVista] = useState<Vista>('mock');
  const [health, setHealth] = useState<Health | null>(null);
  const [cursos, setCursos] = useState<CursoTablero[]>([]);
  const [llamadas, setLlamadas] = useState<LlamadaResumen[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mock: barato, se carga al montar.
  const [mock, setMock] = useState<MockTableroResponse | null>(null);
  const [mockError, setMockError] = useState<string | null>(null);

  // Original: leer tablero-api son varios miles de registros paginados (~25s). Se carga SOLO
  // bajo demanda —al abrir la pestana o al apretar Recargar— nunca al montar la app.
  const [original, setOriginal] = useState<TableroOriginalResponse | null>(null);
  const [originalCargando, setOriginalCargando] = useState(false);
  const [originalError, setOriginalError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const resultados = await Promise.allSettled([
      api.health(),
      api.tablero(),
      api.calls(),
      api.tableroMock(),
    ]);
    const [salud, tablero, calls, mockRes] = resultados;

    if (salud.status === 'fulfilled') setHealth(salud.value);
    if (tablero.status === 'fulfilled') setCursos(tablero.value.cursos);
    if (calls.status === 'fulfilled') setLlamadas(calls.value.llamadas);
    if (mockRes.status === 'fulfilled') {
      setMock(mockRes.value);
      setMockError(null);
    } else {
      setMockError(
        mockRes.reason instanceof Error ? mockRes.reason.message : String(mockRes.reason),
      );
    }

    const fallidos = resultados.filter((r) => r.status === 'rejected');
    if (fallidos.length > 0) {
      const primero = fallidos[0] as PromiseRejectedResult;
      setError(
        primero.reason instanceof Error
          ? primero.reason.message
          : String(primero.reason ?? 'error'),
      );
      if (salud.status === 'rejected') setHealth(null);
    }
    setCargando(false);
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Toda accion del Mock devuelve el tablero completo ya recalculado por el backend: el front
   * nunca reconstruye el estado por su cuenta ni recalcula criticidad.
   */
  const accionMock = useCallback(async (fn: () => Promise<MockTableroResponse>) => {
    setCargando(true);
    setMockError(null);
    try {
      setMock(await fn());
      // Un disparo del Mock crea un seguimiento: refrescar el Dashboard.
      const calls = await api.calls().catch(() => null);
      if (calls) setLlamadas(calls.llamadas);
    } catch (err) {
      setMockError(err instanceof Error ? err.message : String(err));
    } finally {
      setCargando(false);
    }
  }, []);

  const cargarOriginal = useCallback(async (refrescar = false) => {
    setOriginalCargando(true);
    setOriginalError(null);
    try {
      setOriginal(await api.tableroOriginal(refrescar));
    } catch (err) {
      setOriginalError(err instanceof Error ? err.message : String(err));
    } finally {
      setOriginalCargando(false);
    }
  }, []);

  /**
   * Al ENTRAR a la pestana Original se limpia el error anterior, para que el efecto de abajo
   * vuelva a intentar. Sin esto un error quedaba pegado para siempre: si la primera visita
   * fallaba (por ejemplo con el server local corriendo codigo viejo, 404), la pestana seguia en
   * blanco aunque el backend ya estuviera sano, hasta recargar la pagina entera. Paso de verdad.
   */
  const irA = useCallback((destino: Vista) => {
    if (destino === 'original') setOriginalError(null);
    setVista(destino);
  }, []);

  // Primera visita a la pestana Original: se lee ahi, no antes.
  useEffect(() => {
    if (vista === 'original' && !original && !originalCargando && !originalError) {
      void cargarOriginal();
    }
  }, [vista, original, originalCargando, originalError, cargarOriginal]);

  return (
    <div className="uv-root">
      <header className="uv-header">
        <span className="uv-header__icon" aria-hidden="true">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15.5 3.5a5 5 0 0 1 5 5M14.5 7a2.5 2.5 0 0 1 2.5 2.5" />
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h2a1.5 1.5 0 0 1 1.48 1.26l.4 2.4a1.5 1.5 0 0 1-.75 1.55l-1.2.67a11 11 0 0 0 5.19 5.19l.67-1.2a1.5 1.5 0 0 1 1.55-.75l2.4.4A1.5 1.5 0 0 1 20 15v2a1.5 1.5 0 0 1-1.5 1.5h-.5A13.5 13.5 0 0 1 4 6z" />
          </svg>
        </span>
        <div className="uv-header__titles">
          <h1 className="uv-header__title">Umine Voice</h1>
          <p className="uv-header__sub">
            Riesgo de conexion SENCE · resultados de llamadas · disparo manual
          </p>
        </div>
      </header>

      <Banner health={health} />

      {error ? (
        <div className="uv-blocked">
          No se pudo leer la API ({error}). Revisa que `npm run local:server` este corriendo.
        </div>
      ) : null}

      <div className="uv-tabs" role="tablist">
        {VISTAS.map((v) => (
          <button
            key={v.id}
            className="uv-tab"
            role="tab"
            aria-selected={vista === v.id}
            onClick={() => irA(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {vista === 'mock' ? (
        <TableroMock
          data={mock}
          cargando={cargando}
          error={mockError}
          onRecargar={() => void cargar()}
          onGuardar={async (clientId: string, orderNumber: string, patch: MockOrderPatch) => {
            await accionMock(() => api.editarOrdenMock(clientId, orderNumber, patch));
          }}
          onToggleAutoCall={(seccion: SeccionDeVoz, enabled: boolean) =>
            void accionMock(() => api.setAutoCall(seccion, enabled))
          }
          onGuardarReglas={(rules: CallRules) => void accionMock(() => api.setCallRules(rules))}
          onRestaurarReglas={() => void accionMock(() => api.resetCallRules())}
          onReset={() => void accionMock(() => api.resetMock())}
        />
      ) : null}
      {vista === 'original' ? (
        <TableroOriginal
          data={original}
          cargando={originalCargando}
          error={originalError}
          onRecargar={() => void cargarOriginal(true)}
        />
      ) : null}
      {vista === 'dashboard' ? (
        <Dashboard llamadas={llamadas} cargando={cargando} onRefrescar={() => void cargar()} />
      ) : null}
      {vista === 'disparador' ? (
        <Disparador health={health} cursos={cursos} onDisparado={() => void cargar()} />
      ) : null}
    </div>
  );
}
