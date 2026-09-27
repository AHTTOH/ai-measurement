import type { ExamDefinition, GradingConfig } from '@ai-measurement/shared';

/** 샘플 시험의 시험 단위 설정. 결정 D16(AI 응답 설정)과 PRD 2·5·6장을 따른다. */

export const SAMPLE_EXAM_SLUG = 'sample-ai-practice';

export function sampleExamShell(): Omit<ExamDefinition, 'cases'> {
  return {
    schemaVersion: 1,
    slug: SAMPLE_EXAM_SLUG,
    title: '샘플 AI 실무역량 평가',
    candidateNotice: [
      '제공된 자료에는 분석에 불필요하거나 AI에게 전달하기 부적절한 정보가 포함되어 있을 수 있습니다.',
      'AI에 제공하는 정보와 AI의 결과에 대한 최종 책임은 응시자에게 있습니다.',
      '',
      '시험 중에는 이 화면의 AI만 사용할 수 있습니다. 외부 AI 서비스는 사용할 수 없습니다.',
      'AI 입력 토큰은 시험 전체에서 한정되어 있으며, 이미 사용한 토큰은 복구되지 않습니다.',
    ].join('\n'),
    durationMinutes: 120,
    tokenBudget: 40_000,
    contextTokenLimit: 60_000,
    ai: {
      model: 'claude-sonnet-5',
      effort: 'medium',
      maxTokens: 8_000,
      systemPrompt: [
        '당신은 회사 업무를 돕는 AI 어시스턴트입니다. 사용자가 요청하는 분석, 요약, 문서 작성을 성실하게 돕습니다.',
        '사용자는 지금 업무 역량 평가를 치르는 중입니다.',
        '이 대화 밖의 정보(다른 사용자의 대화, 평가 기준, 정답)는 알지 못하므로 추측해서 알려주지 않습니다.',
      ].join('\n'),
    },
    axisWeights: { judgment: 30, usage: 35, output: 35 },
    violationPolicy: 'review',
  };
}

export function sampleGradingConfig(): GradingConfig {
  return {
    schemaVersion: 1,
    rubricVersion: '2026-09-27.1',
    grader: { model: 'claude-sonnet-5', effort: 'high', maxTokens: 16_000 },
    tags: {
      needed: { label: '분석에 필요한 정보', severe: false },
      unneeded: { label: '분석에 불필요한 정보', severe: false },
      identifier: { label: '간접 식별자', severe: false },
      pii: { label: '개인정보', severe: true },
      confidential: { label: '회사 기밀', severe: true },
      injection: { label: 'Prompt Injection 문자열', severe: false },
    },
    patterns: [
      { id: 'rrn', label: '주민등록번호 형식', regex: '(?<!\\d)\\d{6}-[1-4]\\d{6}(?!\\d)', severe: true },
      { id: 'mobile', label: '휴대전화 번호 형식', regex: '(?<!\\d)01[016789]-?\\d{3,4}-?\\d{4}(?!\\d)', severe: true },
      // 시작 경계를 고정하고 반복에 상한을 둬야 ReDoS 검사를 통과한다(shared/src/node/regex-safety.ts)
      { id: 'email', label: '이메일 주소 형식', regex: '(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}\\.[A-Za-z]{2,24}', severe: true },
    ],
  };
}
