import http from 'node:http';

export interface RoundRobinProxy {
  url: string;
  stop(): Promise<void>;
}

/**
 * 요청을 대상 서버에 차례로 나눠 보내는 테스트용 프록시(세션 고정 없음).
 * 수험생 서버 여러 대가 같은 응시자의 요청을 번갈아 받아도 동작하는지 부하 테스트에서 확인한다.
 * Host 헤더는 그대로 넘긴다(서버의 같은 출처 검사가 브라우저 주소 기준으로 동작하도록). SSE 응답은 흘려보낸다.
 */
export function startRoundRobinProxy(targets: readonly string[], port: number): Promise<RoundRobinProxy> {
  const urls = targets.map((t) => new URL(t));
  if (urls.length === 0) throw new Error('프록시 대상이 없습니다');
  let next = 0;
  const server = http.createServer((request, response) => {
    const target = urls[next % urls.length];
    next += 1;
    if (target === undefined) throw new Error('프록시 대상 순번 계산 오류');
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers: request.headers },
      (upstreamResponse) => {
        if (upstreamResponse.statusCode === undefined) throw new Error('대상 서버 응답에 상태 코드가 없습니다');
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`프록시 대상 오류: ${error.message}`);
    });
    // 클라이언트가 끊으면(SSE를 닫으면) 대상 연결도 끊는다
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
