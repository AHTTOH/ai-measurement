import { createDatabase, type DatabaseConnection } from '@ai-measurement/infra';

export interface WaitSample {
  key: string;
  count: number;
}

export interface WaitTimelinePoint {
  atSeconds: number;
  /** 유휴가 아닌 연결 수 */
  active: number;
  /** 잠금·I/O 등을 기다리는 연결의 대기 종류별 수 */
  waits: Record<string, number>;
  /** 이 시점에 돌던 자동 정리(autovacuum) 작업 */
  maintenance: string[];
  /** 유휴가 아닌 연결이 돌리던 쿼리(앞부분)별 수 */
  queries: Record<string, number>;
}

export interface WaitSamplerResult {
  top: WaitSample[];
  timeline: WaitTimelinePoint[];
}

interface ActivityRow {
  state: string | null;
  wait: string | null;
  query: string | null;
  backend: string;
}

/**
 * 부하 중 PostgreSQL 연결들이 무엇을 기다리는지 주기적으로 센다(pg_stat_activity).
 * 연결 풀이 막히는 원인(잠금, 커밋 대기, 자동 정리 등)을 수치와 시간축으로 찾는 진단 도구다.
 */
export function startDatabaseWaitSampler(owner: DatabaseConnection, intervalMs: number, startedAt = performance.now()): { stop(): Promise<WaitSamplerResult> } {
  const handle = createDatabase(owner, { maxConnections: 1 });
  const counts = new Map<string, number>();
  const timeline: WaitTimelinePoint[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const rows = await handle.client<ActivityRow[]>`
        SELECT state, wait_event_type || ':' || wait_event AS wait,
               left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 70) AS query, backend_type AS backend
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`;
      const point: WaitTimelinePoint = { atSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(1)), active: 0, waits: {}, maintenance: [], queries: {} };
      for (const row of rows) {
        if (row.backend === 'autovacuum worker') {
          point.maintenance.push(row.query ?? '');
          continue;
        }
        if (row.backend !== 'client backend') continue;
        const key = `${row.state ?? '-'} | ${row.wait ?? 'running'} | ${row.state === 'idle' ? '' : (row.query ?? '')}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (row.state === 'idle') continue;
        point.active += 1;
        const query = (row.query ?? '').slice(0, 45);
        point.queries[query] = (point.queries[query] ?? 0) + 1;
        if (row.wait !== null && row.wait !== 'Client:ClientRead') point.waits[row.wait] = (point.waits[row.wait] ?? 0) + 1;
      }
      timeline.push(point);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      await handle.close();
      return { top: [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count), timeline };
    },
  };
}
