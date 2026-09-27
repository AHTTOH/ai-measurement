# server · 수험생 서버와 관리자 서버

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 구조 분리: 한 패키지에서 두 프로세스로)

## 책임

- 인증·세션·타이머. 서버 시각이 유일한 기준이다
- 시험 패키지 등록과 자료 제공. `exams/`는 읽기 전용이고, 자료는 등록 당시 해시와 대조한 뒤에만 쓴다
- AI 프록시. Claude API 호출은 `modules/ai`의 게이트웨이에서만 한다
- 토큰 원장. 전송 전에 계산하고 세션 행을 잠근 트랜잭션에서 차감한다
- 답안 자동저장·버전·제출, 공지 노출 기록
- 감사 로그와 관리자 조회

## 내부 구조 (D1 확정: Hono + Drizzle, 2026-09-27)

| 위치 | 담는 것 |
|---|---|
| `src/candidate-main.ts` | 수험생 서버 진입점. DB 역할 `aim_candidate_server`, 만료 세션 정리 타이머 |
| `src/admin-main.ts` | 관리자 서버 진입점. DB 역할 `aim_admin_server` |
| `src/candidate-app.ts`, `src/admin-app.ts` | 각 서버의 Hono 앱. 자기 API(`/api/candidate` 또는 `/api/admin`)만 붙인다 |
| `src/candidate-services.ts`, `src/admin-services.ts` | 각 서버의 서비스 조립(구성 루트). 모듈은 여기서 주입받은 서비스만 쓴다 |
| `src/http/` | 공통 앱 틀(`app-shell.ts`: 보안 헤더, 본문 한도, 오류 응답), 라우트, SSE 스트림, 웹 정적 파일, 프로세스 기동·종료 |
| `src/config/` | 환경변수 스키마(수험생·관리자·공통 로그인 정책) |
| `src/lib/` | 오류 타입, 해시·토큰, 시계, 한도 계산기, DB 오류 판별 |
| `src/modules/<도메인>/` | auth, exams, sessions, ledger, materials, ai, answers, notices, candidate, admin, audit |

## 규칙

- 모듈은 다른 모듈의 서비스 클래스와 타입만 쓴다. 내부 함수를 가져다 쓰지 않는다. 공유 형식은 `shared/`, DB 형식은 `infra/`에 둔다.
- API 키 등 시크릿은 환경변수로만 읽는다. 필수 값이 없으면 기동을 거부한다(`infra/.env.example`).
- 메시지·원장·답안 버전·감사 로그는 수정·삭제하지 않는다. 새 행만 추가한다.
- 응답 스트리밍 진행 상태를 메모리에 두므로 수험생 서버는 단일 인스턴스로 운영한다(결정 D1).
- 두 서버는 서로의 서비스를 조립하지 않는다. 시험 행은 `modules/exams/exam-columns.ts`의 컬럼 목록으로만 읽는다(루브릭·정답은 DB 권한으로 막혀 있다).
- 권한 구조: `docs/decisions/2026-09-27-권한-구조-분리.md`

설계 근거: `docs/plan/2026-09-27-prd-구현계획.md` 2장, 4장
