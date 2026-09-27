# 결정 D17: DB는 Supabase(PostgreSQL)

> 결정일: 2026-09-27 · 결정자: 신영환 · 기록: Claude (Opus 5.5 세션)
> 근거: 2026-09-27 신영환 지시 "db는 supabase 써라". 액세스 토큰은 `.env`의 `SUPABASE_ACCESS_TOKEN`(커밋하지 않음).
> 바뀌는 결정: D1의 "운영 DB는 별도 PostgreSQL". 개발·테스트용 임베디드 PostgreSQL은 그대로 둔다.

## 결정

| 항목 | 값 |
|---|---|
| 프로젝트 | `ai-test`(ref `jbsmrwkeprsxrvtyblin`), 조직 `eshish853`(무료 플랜), 리전 서울(ap-northeast-2), PostgreSQL 17 |
| 고른 이유 | 계정에 이미 있는 빈 활성 프로젝트다(`public` 테이블 0개 확인). 새로 만들면 무료 활성 프로젝트 슬롯(2개)을 하나 더 쓴다. 다른 프로젝트 `my-saju`는 일시정지 상태라 쓰지 않았다 |
| 접속 | Supavisor 풀러 세션 모드 `aws-0-ap-northeast-2.pooler.supabase.com:5432`, SSL 필수. 세션 모드라 LISTEN/NOTIFY(수험생 서버 다중 인스턴스)가 된다. 트랜잭션 모드(6543)는 쓰지 않는다 |
| 사용자 이름 | 풀러는 `계정.프로젝트ref`를 받는다. `DATABASE_POOLER_PROJECT_REF`를 두면 코드가 접속 이름에만 붙인다. DB 안의 역할 이름은 그대로다 |
| 스키마 소유자 | 전용 역할 `aim_owner`(LOGIN, CREATEROLE, 슈퍼유저 아님). Supabase의 `postgres` 계정 비밀번호는 건드리지 않았다. 마이그레이션·DB 로그인 적용·운영자 생성만 이 계정으로 한다 |
| 서버·워커 계정 | 권한 분리 결정 그대로. `aim_candidate_login`, `aim_admin_login`, `aim_grading_login`이 각 역할에 들어간다 |
| 연결 수 | DB 한도 60, Supabase 내부가 약 14개를 쓴다. 수험생 서버 10, 관리자 서버 3, 채점 워커 3으로 둔다 |

## 외부 노출 차단

Supabase는 `public` 스키마를 Data API(REST·GraphQL, anon 키)로 공개할 수 있다. 루브릭·정답·PIN 해시가 이 경로로 새면 안 된다.

| 조치 | 확인 |
|---|---|
| 테이블을 `aim_owner`가 만들어 Supabase 기본 권한(anon·authenticated·service_role에 자동 부여)이 붙지 않는다 | `public` 테이블에 세 역할의 권한 0건(2026-09-27 조회) |
| Data API 노출 스키마에서 `public`을 뺐다(`graphql_public`만) | Management API로 설정 후 값 확인 |
| 요청 한도 DB 함수의 실행 권한을 PUBLIC에서 회수했다 | 마이그레이션 0005·0006 |

## 적용 절차 (2026-09-27 실행)

1. Management API SQL로 `aim_owner` 생성, DB·`public` 스키마 권한 부여(`workspace/supabase-bootstrap.mjs`)
2. `npm run db:migrate` → 마이그레이션 0000~0006 적용
3. `npm run db:logins` → 역할별 로그인 계정
4. `npm run admin:create -- --username operator`
5. 로컬 서버 두 대를 Supabase에 붙여 확인: 시험 등록·열기, 응시자 발급, 로그인, 시작, AI 전송(모의)과 스트림 완료, 답안 저장 모두 정상

## 그대로 두는 것

- 자동 테스트(통합·E2E·부하)는 계속 임베디드 PostgreSQL을 띄워 돈다. 운영 DB에 테스트 데이터가 쌓이지 않게 하고, 무료 플랜 연결 한도를 테스트가 쓰지 않게 하기 위해서다.
- `npm run db:dev`는 오프라인 개발용으로 남긴다. 쓰려면 `.env`의 DB 항목을 로컬 값으로 바꾼다.
