/**
 * ContactRepository — CONTACT#<telefono_e164> META, ver prompt §8.
 * Guarda do_not_call (permanente una vez marcado) y last_contacted_at (para el cooldown).
 */

import { BaseRepository } from './base-repository.js';

export interface Contact {
  phone: string;
  nombre: string | null;
  cliente: string | null;
  doNotCall: boolean;
  lastContactedAt: string | null;
  consent: boolean;
}

interface ContactItem extends Contact {
  PK: string;
  SK: 'META';
}

function contactPk(phone: string): string {
  return `CONTACT#${phone}`;
}

export class ContactRepository extends BaseRepository {
  async getByPhone(phone: string): Promise<Contact | null> {
    return this.getItem<ContactItem>({ PK: contactPk(phone), SK: 'META' });
  }

  async isDoNotCall(phone: string): Promise<boolean> {
    const contact = await this.getByPhone(phone);
    return contact?.doNotCall ?? false;
  }

  /** Marca do_not_call = true de forma PERMANENTE (prompt §5.4 — nunca se revierte automaticamente). */
  async markDoNotCall(phone: string): Promise<void> {
    const existing = await this.getByPhone(phone);
    const item: ContactItem = {
      phone,
      nombre: existing?.nombre ?? null,
      cliente: existing?.cliente ?? null,
      doNotCall: true,
      lastContactedAt: existing?.lastContactedAt ?? null,
      consent: existing?.consent ?? false,
      PK: contactPk(phone),
      SK: 'META',
    };
    await this.putItem(item);
  }

  async markContacted(phone: string, whenIso: string = new Date().toISOString()): Promise<void> {
    const existing = await this.getByPhone(phone);
    const item: ContactItem = {
      phone,
      nombre: existing?.nombre ?? null,
      cliente: existing?.cliente ?? null,
      doNotCall: existing?.doNotCall ?? false,
      lastContactedAt: whenIso,
      consent: existing?.consent ?? false,
      PK: contactPk(phone),
      SK: 'META',
    };
    await this.putItem(item);
  }
}
