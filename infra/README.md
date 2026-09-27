# infra · DB와 운영 설정

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 구조 분리: 역할별 DB 로그인)

## 담는 것

| 위치 | 담는 것 |
|---|---|
| `db/schema.ts` | Drizzle 스키마(테이블 17개). PRD 11장 저장 데이터 |
| `db/migrations/` | drizzle-kit이 만든 SQL 마이그레이션 |
| `db/client.ts` | DB 연결과 마이그레이션 적용 함수 |
| `db/connection.ts` | 접속 정보(호스트·포트·DB 이름은 공통, 계정은 프로세스마다 다른 환경변수) |
| `db/access-roles.ts` | 프로세스 역할 이름과 역할별 로그인 계정 적용(`npm run db:logins`) |
| `db/migrations/0001_access-roles.sql` | 역할 생성과 테이블·컬럼 권한. 권한 표는 `docs/decisions/2026-09-27-권한-구조-분리.md` |
| `logging/` | 서버·워커 공용 한 줄 JSON 로그 |
| `.env.example` | 필요한 환경변수의 이름과 설명. 값은 넣지 않는다 |

## 규칙

- 스키마를 바꾸면 마이그레이션을 새로 만든다: `npm run db:generate -- <이름>`. 이미 적용한 마이그레이션 파일은 고치지 않는다.
- 운영 DB는 Supabase(결정 D17, 풀러 세션 모드, SSL)다. 별도 PostgreSQL을 `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`과 프로세스별 계정으로 연결한다. `scripts/start-dev-database.ts`의 임베디드 PostgreSQL은 개발·테스트 전용이다.
- 새 테이블을 만들면 역할별 권한을 주는 마이그레이션을 함께 만든다. 대화·원장·답안·감사 로그 같은 기록 테이블에는 어느 역할에도 UPDATE·DELETE를 주지 않는다.
- 실제 `.env`와 키 파일은 커밋하지 않는다.
