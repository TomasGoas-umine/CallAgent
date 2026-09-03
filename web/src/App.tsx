import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { Banner } from './components/Banner';
import { Tablero } from './components/Tablero';
import { Dashboard } from './components/Dashboard';
import { Disparador } from './components/Disparador';
import type { CursoTablero, Health, LlamadaResumen } from './types';

type Vista = 'tablero' | 'dashboard' | 'disparador';

const VISTAS: Array<{ id: Vista; label: string }> = [
  { id: 'tablero', label: 'Tablero' },
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
  const [vista, setVista] = useState<Vista>('tablero');
  const [health, setHealth] = useState<Health | null>(null);
  const [cursos, setCursos] = useState<CursoTablero[]>([]);
  const [llamadas, setLlamadas] = useState<LlamadaResumen[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const resultados = await Promise.allSettled([api.health(), api.tablero(), api.calls()]);
    const [salud, tablero, calls] = resultados;

    if (salud.status === 'fulfilled') setHealth(salud.value);
    if (tablero.status === 'fulfilled') setCursos(tablero.value.cursos);
    if (calls.status === 'fulfilled') setLlamadas(calls.value.llamadas);

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

  return (
    <div className="uv-root">
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
            onClick={() => setVista(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>

      {vista === 'tablero' ? (
        <Tablero cursos={cursos} cargando={cargando} onRefrescar={() => void cargar()} />
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
