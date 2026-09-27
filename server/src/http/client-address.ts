import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

/**
 * 요청을 보낸 쪽의 TCP 주소. 리버스 프록시 뒤에서는 프록시 주소가 되므로 IP별 한도가 사실상 전체 한도가 된다
 * (운영 절차서에 적는다). 주소를 알 수 없으면 한도를 적용할 수 없으므로 요청을 거부한다.
 */
export function clientAddress(c: Context): string {
  const address = getConnInfo(c).remote.address;
  if (address === undefined || address === '') throw new Error('접속 주소를 알 수 없습니다');
  return address;
}
