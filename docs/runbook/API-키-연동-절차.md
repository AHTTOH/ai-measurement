# Claude API 키 연동 절차

> 최초 작성: 2026-09-27 · 마지막 갱신: 2026-09-27 (권한 구조 분리 반영: 키는 수험생 서버와 채점 워커만 받는다)
> 배경: API 키는 결제 후 받기로 했다(결정 `docs/decisions/2026-09-27-AI-모의-게이트웨이.md`). 그전까지 모든 개발·테스트는 모의 AI로 했다.
> 키를 받으면 이 순서대로 연동하고, 결과를 `docs/audit/`에 날짜 파일로 남긴다.

## 1. 키 넣기

루트 `.env`:

```
ANTHROPIC_API_KEY=발급받은 키
AI_PROVIDER=anthropic
GRADING_LLM_PROVIDER=anthropic
```

`MOCK_AI_CHUNK_DELAY_MS`는 `AI_PROVIDER=anthropic`이면 쓰지 않는다. 수험생 서버와 채점 워커를 다시 띄운다. 관리자 서버는 키를 읽지 않는다.

- 운영에서 프로세스별 환경 파일을 쓰면 키는 `candidate.env`와 `worker.env`에만 넣는다(`docs/runbook/시험-운영-절차.md`의 '프로세스별 환경 파일').
- 응시 화면 계기판의 '모의 AI' 표시가 사라져야 한다. 운영 화면의 '응시 AI 기록'은 실제 대화가 생긴 뒤에 'Claude API'로 보인다(관리자 서버는 메시지에 남은 기록으로만 안다).

## 2. 실제 호출로 확인할 것 (구현계획 P0 스파이크 1, 결정 D15)

| 확인 항목 | 방법 | 기대 |
|---|---|---|
| 응시용 AI 스트리밍 | 응시 화면에서 한 문장 전송 | 답이 조각으로 흘러나오고 저장된다 |
| 토큰 계산 | 전송 후 원장의 차감량과 메시지의 `contextTokens` | 차감량은 신규 전송분만, 컨텍스트는 이력 포함(결정 D2) |
| 캐시 적중 | 같은 대화에서 두 번째 전송 후 응시 상세 → 대화의 '캐시 읽기' | 두 번째부터 0보다 크다. 0이면 요청 앞부분이 매번 바뀌는 것이므로 조사한다 |
| PDF 첨부 | 출장비 규정 2쪽만 첨부해 질문 | 답이 2쪽 내용만 근거로 한다 |
| thinking 블록 재전송 | 3턴 이상 대화 | 오류 없이 이어진다(응답 content를 바꾸지 않고 다시 보낸다) |
| 채점 즉시 모드 | 응시 1건 제출 후 채점 실행(즉시) | 기준 항목에 근거(메시지 번호)와 이유가 채워진다 |
| 채점 배치 모드 | 같은 시험으로 배치 채점 | '배치 결과 대기' 후 완료 |
| 조직 사용 티어 | Claude 콘솔 Rate limits 페이지 또는 Rate Limits API | 120명 동시 응시를 버티는 한도인지(구현계획 9장 계산: 캐시가 작동하면 Start 티어로도 여유) |
| 월 지출 상한 | 콘솔 Billing | 시험 1회 추정 비용(구현계획 9장)보다 넉넉한지 |

## 3. 코드에서 확인이 필요한 지점

실제 API 응답으로만 검증할 수 있어 모의 테스트에서 빠진 부분이다.

- `server/src/modules/ai/anthropic-gateway.ts`: `messages.stream`, `countTokens`, 오류 종류 변환
- `grading/src/llm/anthropic-grader.ts`: 구조화 출력(`output_config.format`), `refusal`·`max_tokens` 처리, 배치 결과 읽기
- 모델 ID는 시험 패키지 `ai.model`(응시용)과 `grading.json`의 `grader.model`(채점용)에 있다. 코드에는 없다

## 4. 끝나면

- 결과를 `docs/audit/YYYY-MM-DD-API-연동-검증.md`로 남긴다
- 구현계획 0장 D15를 '확정'으로 바꾸고 결정 파일을 만든다
