# scripts · 운영 스크립트

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 구조 분리: DB 로그인 적용 스크립트 추가)

## 목록

| 파일 | 하는 일 | 실행 |
|---|---|---|
| `start-dev-database.ts` | 로컬 개발용 PostgreSQL 기동 | `npm run db:dev` |
| `migrate-database.ts` | 마이그레이션 적용(역할 생성·권한 부여 포함) | `npm run db:migrate` |
| `apply-database-logins.ts` | 수험생 서버·관리자 서버·채점 워커의 DB 로그인 계정을 만들거나 비밀번호를 바꾸고 역할에 넣는다 | `npm run db:logins` |
| `create-admin.ts` | 운영자 계정 생성(비밀번호는 `NEW_ADMIN_PASSWORD` 환경변수) | `npm run admin:create -- --username <아이디>` |
| `validate-exam-package.ts` | 시험 패키지 폴더 검증 | `npm run exam:validate -- exams/<slug>` |
| `build-sample-exam-package.ts` | 샘플 시험 패키지 재생성(가공 데이터, 시드 고정) | `npm run exam:build-sample` |
| `sample-exam-package/` | 샘플 생성기의 Case별 모듈 | |

DB를 다루는 세 스크립트(마이그레이션·로그인 적용·운영자 생성)는 스키마 소유자 계정(`MIGRATION_DB_USER`)으로 접속한다. 서버·워커 계정으로는 할 수 없는 일이다.

응시자 발급과 채점 실행은 관리자 화면에서 한다. 부하 테스트는 `tests/load/`에 있다.

## 규칙

- 파일명은 '동사-대상' 형태로 짓는다. 이름만 보고 하는 일을 알 수 있어야 한다.
- 일회성 디버그·실험 스크립트는 여기가 아니라 `workspace/`에 둔다.
