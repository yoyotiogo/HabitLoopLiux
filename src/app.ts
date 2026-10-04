import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { HabitService } from './service';
import { Identity, Repository } from './types';

export interface AppOptions { allowedAppId: string; allowLocalAuth?: boolean; }
export class Authentication {
  static identity(req: Request, options: AppOptions): Identity | null {
    if (options.allowLocalAuth && req.socket.remoteAddress?.includes('127.0.0.1') && req.get('x-habitloop-test-user')) return { appId: options.allowedAppId, openId: req.get('x-habitloop-test-user')! };
    const appId = req.get('x-wx-appid'), openId = req.get('x-wx-openid'), source = req.get('x-wx-source');
    if (!['wx_client','wx_devtools'].includes(source || '') || appId !== options.allowedAppId || !openId || openId.length > 128) return null;
    return { appId, openId };
  }
}
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  allow(identity: Identity): boolean {
    const now = Date.now(), key = identity.appId + ':' + identity.openId, bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start > 60000) {
      if (this.buckets.size > 10000) for (const [id, old] of this.buckets) if (now - old.start > 60000) this.buckets.delete(id);
      this.buckets.set(key, { start: now, count: 1 }); return true;
    }
    return ++bucket.count <= 120;
  }
}
export function createApp(service: HabitService, repository: Repository, options: AppOptions) {
  const app = express(), limiter = new RateLimiter();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.get('/', (_req, res) => res.json({ application: 'HabitLoop', version: '1.0.0', status: 'running' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, application: 'HabitLoop' }));
  app.post('/api/v1/commands', async (req, res) => {
    const identity = Authentication.identity(req, options);
    if (!identity) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', requestId: req.body?.requestId || randomUUID(), serverTime: new Date().toISOString(), error: { message: '请使用微信小程序访问。', details: {}, retryable: false } });
    if (!limiter.allow(identity)) return res.status(429).json({ ok: false, code: 'RATE_LIMITED', requestId: req.body?.requestId || randomUUID(), serverTime: new Date().toISOString(), error: { message: '操作过于频繁，请稍后重试。', details: {}, retryable: true } });
    return res.json(await service.execute(identity, req.body));
  });
  app.get('/api/exports/:jobId', async (req, res, next) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return res.sendStatus(404);
      const snapshot = await repository.exportDownload(String(req.params.jobId), token, new Date());
      if (!snapshot) return res.sendStatus(404);
      res.set('Cache-Control', 'no-store'); res.set('Content-Disposition', 'attachment; filename="HabitLoop-export.json"');
      return res.json(snapshot);
    } catch (error) { next(error); }
  });
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('habitloop_http_error', error?.type || error?.code || 'INTERNAL_ERROR');
    res.status(error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 500).json({ ok: false, code: 'INVALID_REQUEST', requestId: randomUUID(), serverTime: new Date().toISOString(), error: { message: '请求未能处理，请检查参数后重试。', details: {}, retryable: false } });
  });
  return app;
}
