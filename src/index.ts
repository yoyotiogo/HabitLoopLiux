import { config } from 'dotenv';
import { resolve } from 'node:path';
import { MysqlRepository } from './mysql-repository';
import { MemoryRepository } from './repository';
import { HabitService } from './service';
import { createApp } from './app';

class Server {
  async start(): Promise<void> {
    config({ path: resolve(__dirname, '../.env.local') });
    const localTest = process.env.NODE_ENV === 'test' && process.env.HABITLOOP_LOCAL_TEST === 'true';
    const repository = localTest ? new MemoryRepository() : new MysqlRepository();
    await repository.initialize();
    const service = new HabitService(repository);
    const app = createApp(service, repository, { allowedAppId: process.env.ALLOWED_APP_ID || 'wx235f2f2ee86e38a5', allowLocalAuth: localTest });
    const server = app.listen(Number(process.env.PORT || 80), '0.0.0.0', () => console.log('HabitLoop listening', process.env.PORT || 80, localTest ? 'local-test-memory' : 'mysql'));
    let running = false;
    const interval = setInterval(async () => {
      if (running) return; running = true;
      try { await service.maintenance(); } catch (error) { console.error('maintenance_failed', (error as any)?.code || 'INTERNAL_ERROR'); }
      finally { running = false; }
    }, 5000);
    const stop = () => { clearInterval(interval); server.close(async () => { if (repository instanceof MysqlRepository) await repository.close(); process.exit(0); }); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }
}
new Server().start().catch(error => { console.error('startup_failed', error?.code || error?.message || 'Unknown error'); process.exit(1); });
