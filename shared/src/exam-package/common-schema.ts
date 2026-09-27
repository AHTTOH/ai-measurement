import { z } from 'zod';

/** 케이스·자료·하위문항·공지·규칙 등 시험 패키지 안 식별자의 형식 */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const keySchema = z
  .string()
  .regex(KEY_PATTERN, '소문자 영문, 숫자, 하이픈만 쓸 수 있고 63자 이하여야 합니다');

export const nonEmptyText = z.string().trim().min(1, '빈 값일 수 없습니다');

export const positivePoints = z.number().positive('배점은 0보다 커야 합니다');

export interface PackageIssue {
  /** 문제가 난 파일(패키지 루트 기준 상대 경로) */
  file: string;
  /** 파일 안 위치. 예: cases.0.subquestions.2.key */
  path: string;
  message: string;
}

export function zodIssuesToPackageIssues(file: string, error: z.ZodError): PackageIssue[] {
  return error.issues.map((issue) => ({
    file,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
