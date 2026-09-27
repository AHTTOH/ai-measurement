/**
 * 다른 Node 프로세스의 디버거(--inspect)에 붙어 CPU 프로파일을 뜬다. 부하 테스트 병목 진단용.
 * Node 내장 WebSocket으로 Chrome DevTools Protocol의 Profiler 도메인을 부른다.
 */
interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

export interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

export interface HotFunction {
  name: string;
  selfMs: number;
  share: number;
}

export interface ProfilerSession {
  stop(): Promise<{ profile: CpuProfile; hot: HotFunction[] }>;
}

/** 표본 간격(마이크로초) */
const SAMPLING_INTERVAL_US = 500;
/** 결과에 넣을 상위 함수 수 */
const TOP_FUNCTIONS = 30;

async function debuggerUrl(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as Array<{ webSocketDebuggerUrl?: string }>;
  const url = targets[0]?.webSocketDebuggerUrl;
  if (url === undefined) throw new Error(`디버거 대상이 없습니다(포트 ${port})`);
  return url;
}

export async function startCpuProfile(port: number): Promise<ProfilerSession> {
  const socket = new WebSocket(await debuggerUrl(port));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('디버거에 연결하지 못했습니다')), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
    if (message.id !== undefined) pending.get(message.id)?.(message.result);
  });
  const call = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await call('Profiler.enable');
  await call('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
  await call('Profiler.start');
  return {
    stop: async () => {
      const { profile } = (await call('Profiler.stop')) as { profile: CpuProfile };
      socket.close();
      return { profile, hot: hotFunctions(profile) };
    },
  };
}

/** 표본마다 가장 안쪽 함수에 시간을 준다(자기 시간). 상위 함수를 돌려준다 */
function hotFunctions(profile: CpuProfile): HotFunction[] {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  let totalUs = 0;
  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index];
    const frame = byId.get(id)?.callFrame;
    if (delta === undefined || frame === undefined) return;
    totalUs += delta;
    const file = frame.url.split(/[\\/]/u).slice(-2).join('/');
    const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + delta);
  });
  return [...self.entries()]
    .map(([name, us]) => ({ name, selfMs: Math.round(us / 1000), share: Number((us / totalUs).toFixed(3)) }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, TOP_FUNCTIONS);
}
