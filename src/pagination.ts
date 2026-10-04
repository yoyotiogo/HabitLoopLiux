import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BusinessError } from './errors';
import { Document } from './types';

export class Pagination {
  constructor(private secret: string) {}
  static fingerprint(value: any): string { return createHash('sha256').update(Pagination.canonical(value)).digest('hex'); }
  static canonical(value: any): string {
    if (Array.isArray(value)) return '[' + value.map(item => Pagination.canonical(item)).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + Pagination.canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  binding(owner: string, action: string, payload: Document): string {
    const { cursor, limit, ...filters } = payload;
    return Pagination.fingerprint({ owner, action, filters });
  }
  decode(cursor: string | null | undefined, binding: string): { sortAt: string; id: string } | undefined {
    if (!cursor) return undefined;
    try {
      const [text, signature] = cursor.split('.');
      const expected = createHmac('sha256', this.secret).update(text).digest('hex');
      if (signature?.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error();
      const parsed = JSON.parse(Buffer.from(text, 'base64url').toString());
      if (parsed.binding !== binding || typeof parsed.id !== 'string' || typeof parsed.sortAt !== 'string') throw new Error();
      return { sortAt: parsed.sortAt, id: parsed.id };
    } catch { throw new BusinessError('INVALID_CURSOR', '列表游标已失效，请刷新。'); }
  }
  encode(binding: string, document: Document): string {
    const text = Buffer.from(JSON.stringify({ binding, id: document._id, sortAt: document.businessDate || document.updatedAt || document.createdAt || '' })).toString('base64url');
    return text + '.' + createHmac('sha256', this.secret).update(text).digest('hex');
  }
}
