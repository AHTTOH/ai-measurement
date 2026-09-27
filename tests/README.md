# tests · 테스트

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 테스트, 다중 인스턴스 테스트, 브라우저별 E2E, 부하 프로필)

## 종류와 실행

| 폴더 | 내용 | 실행 |
|---|---|---|
| `unit/` | 스키마·교차 검증, CSV, 탐지, 공지, ReDoS 검사, 채점 규칙·집계·LLM 응답 검증 | `npm test` |
| `integration/` | 실제 PostgreSQL(임베디드)로 서버 흐름 전체: 로그인·세션·채팅·원장·답안·공지·관리자·채점 작업. 수험생·관리자 서버와 채점 워커가 각자 DB 역할로 접속하고, `access-roles.test.ts`가 역할별 권한 경계를, `multi-instance.test.ts`가 수험생 서버 두 대의 스트림·한도 공유를 확인한다 | `npm run test:integration` |
| `e2e/` | Playwright. `exam-lifecycle.spec.ts`: 운영자 등록 → 응시 → 채점·결과(Chromium). `cross-browser.spec.ts`: Chromium·Firefox·WebKit·Edge에서 핵심 동작, axe 접근성(WCAG 2.1 AA 심각·중대 위반 0), 320·768·1024px 가로 넘침 없음. 화면 캡처는 `workspace/e2e-screenshots` | `npm run test:e2e` |
| `load/` | 가상 응시자 N명 부하 테스트(모의 AI). 프로필 burst(과부하)·rehearsal(120분 리허설, 끝나면 채점). 진단: DB 대기 표본(`LOAD_TEST_DB_SAMPLING_MS`), CPU 프로파일(`LOAD_TEST_CPU_PROFILE=1`). 결과는 `workspace/load-test` | `npx tsx tests/load/run-load-test.ts 120 180 1 burst` |
| `support/` | E2E·부하 테스트가 함께 쓰는 격리 환경(전용 DB, 수험생 서버 1대 이상·관리자 서버·워커를 각자 DB 로그인으로, 여러 대면 라운드로빈 프록시) | |

커버리지(단위 + 통합): `npm run test:coverage`. 목표 80%는 server, grading, shared에 적용한다.

## 규칙

- 테스트는 실제 Claude API를 부르지 않는다. 모의 AI·모의 채점기를 명시적으로 쓴다. 실제 API 검증은 키 발급 후 별도로 한다.
- 부하·검증 결과 리포트는 `docs/audit/`에 날짜 파일로 남긴다.
- 통합 테스트의 `TestClient`는 `/api/admin/` 요청을 관리자 앱으로, 나머지를 수험생 앱으로 보낸다. 쿠키 저장소는 하나다(브라우저처럼 포트를 구분하지 않는다).
- 픽스처 준비·결과 확인은 스키마 소유자 연결(`server.db`)로 하고, 서버 동작은 반드시 서버 서비스나 HTTP로 한다.

설계 근거: `docs/plan/2026-09-27-prd-구현계획.md` 11장
