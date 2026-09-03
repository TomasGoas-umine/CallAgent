/** Limpia el DOM entre tests (no se usa `globals: true`, asi que se registra a mano). */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
