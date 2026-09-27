/**
 * 전송 본문에서 개인정보 패턴과 자료 값 지문을 찾는 순수 함수.
 * 서버(전송 시 기록)와 채점(규칙 판정)이 같은 함수를 쓴다.
 */

export interface PatternLike {
  id: string;
  regex: string;
}

export interface PatternHit {
  patternId: string;
  count: number;
}

const compiledPatterns = new Map<string, RegExp>();

function compile(source: string): RegExp {
  const cached = compiledPatterns.get(source);
  if (cached !== undefined) return cached;
  const regex = new RegExp(source, 'gu');
  compiledPatterns.set(source, regex);
  return regex;
}

export function findPatternHits(text: string, patterns: readonly PatternLike[]): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const pattern of patterns) {
    const regex = compile(pattern.regex);
    regex.lastIndex = 0;
    const count = [...text.matchAll(regex)].length;
    if (count > 0) hits.push({ patternId: pattern.id, count });
  }
  return hits;
}

/** 공백·하이픈·점·괄호를 지워 서식만 바꾼 값도 같은 값으로 본다. 예: 010-1234-5678과 01012345678 */
export function normalizeForMatch(value: string): string {
  return value.replace(/[\s\-.()]/gu, '');
}

/**
 * text 안에 들어 있는 값들을 돌려준다(중복 제거).
 * minLength는 정규화한 값 기준이며, 그보다 짧은 값은 우연 일치가 잦아 검사하지 않는다.
 */
export function findContainedValues(text: string, values: Iterable<string>, minLength: number): string[] {
  const normalizedText = normalizeForMatch(text);
  const found = new Set<string>();
  for (const value of values) {
    const normalizedValue = normalizeForMatch(value);
    if (normalizedValue.length < minLength) continue;
    if (normalizedText.includes(normalizedValue)) found.add(value);
  }
  return [...found];
}

/** 지정한 문구 중 text에 들어 있는 것 */
export function findContainedTexts(text: string, texts: readonly string[]): string[] {
  const normalizedText = normalizeForMatch(text);
  return texts.filter((candidate) => normalizedText.includes(normalizeForMatch(candidate)));
}
