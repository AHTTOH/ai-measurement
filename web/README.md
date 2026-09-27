# web · 프론트엔드

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 구조 분리: 수험생·관리자 빌드 분리)

## 표면

두 표면을 따로 빌드하고 각 서버가 자기 빌드만 제공한다. 수험생 번들에는 관리자 코드가 없고, 관리자 번들에는 응시 코드가 없다.

| 표면 | 진입 HTML | 진입 코드 | 빌드 결과 | 제공 서버 |
|---|---|---|---|---|
| 응시자 화면(`/`): 로그인, 시작 전 안내, 작업대, 종료 | `index.html` | `src/candidate-main.tsx` | `dist/candidate` | 수험생 서버 |
| 관리자 화면(`/admin`): 시험 목록·등록, 시험 상세, 응시 상세 | `admin.html` | `src/admin-main.tsx` | `dist/admin` | 관리자 서버 |

빌드: `npm run build:web`(두 벌을 차례로 만든다). Vite 모드가 표면을 고른다(`--mode candidate`, `--mode admin`).

## 내부 구조 (D1 확정: React + Vite + React Router, 2026-09-27)

| 위치 | 담는 것 |
|---|---|
| `src/candidate-main.tsx`, `src/admin-main.tsx` | 표면별 라우터 |
| `src/candidate/` | 응시자 화면 컴포넌트와 훅 |
| `src/admin/` | 관리자 화면 |
| `src/api/` | 서버 API 호출(응답 봉투 해석) |
| `src/ui/` | 공용 표시 부품(마크다운, 형식 변환, 자원 상태 단계, 라우터 마운트, 없는 화면) |
| `src/styles/` | 토큰(`tokens.css`), 기본, 화면별 스타일 |

## 규칙

- 브라우저는 Claude API를 직접 호출하지 않는다. 서버의 스트리밍 엔드포인트만 쓴다.
- 남은 시간과 남은 토큰은 서버가 준 값을 표시만 한다. 클라이언트에서 계산하지 않는다.
- 색·간격·타이포는 `styles/tokens.css`의 토큰으로만 쓴다. 설계는 `docs/plan/2026-09-27-웹-화면-설계.md`.
- 개발 서버는 표면마다 따로 띄운다. 수험생은 `npm run dev:web:candidate`(`WEB_DEV_CANDIDATE_API_ORIGIN`), 관리자는 `npm run dev:web:admin`(`WEB_DEV_ADMIN_API_ORIGIN`).
- 한 표면의 코드가 다른 표면 폴더(`src/candidate`, `src/admin`)를 가져다 쓰지 않는다. 함께 쓰는 것은 `src/ui`, `src/api/http.ts`, `src/styles`에 둔다.

설계 근거: `docs/plan/2026-09-27-prd-구현계획.md` 4장, 6장
