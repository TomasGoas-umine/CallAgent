/**
 * dynalite no publica tipos propios ni existe @types/dynalite. Se usa solo para levantar un
 * servidor DynamoDB local en memoria (ver scripts/dynalite-server.ts y test/integration/).
 */
declare module 'dynalite' {
  import type { Server } from 'node:http';

  interface DynaliteOptions {
    createTableMs?: number;
    deleteTableMs?: number;
    updateTableMs?: number;
    path?: string;
    ssl?: boolean;
  }

  function dynalite(options?: DynaliteOptions): Server;
  export default dynalite;
}
