import { startIsolatedStack } from '../../support/isolated-stack';
import { E2E_ADMIN_PORT, E2E_CANDIDATE_PORT } from './e2e-urls';

/**
 * E2E 환경: 전용 PostgreSQL, 수험생 서버·관리자 서버(각자 빌드된 웹 포함, 모의 AI), 채점 워커(모의 LLM)를 띄운다.
 * 웹은 미리 빌드해 둔다(npm run test:e2e가 build:web을 먼저 실행한다).
 */
export default async function setup(): Promise<() => Promise<void>> {
  const stack = await startIsolatedStack({
    label: 'e2e',
    candidatePort: E2E_CANDIDATE_PORT,
    candidateInstances: 1,
    adminPort: E2E_ADMIN_PORT,
    candidateEnv: { MOCK_AI_CHUNK_DELAY_MS: '20', CANDIDATE_AI_REQUESTS_PER_MINUTE: '60' },
    withWorker: true,
    inspectCandidates: false,
  });
  process.env['E2E_ADMIN_USERNAME'] = stack.admin.username;
  process.env['E2E_ADMIN_PASSWORD'] = stack.admin.password;
  return stack.stop;
}
