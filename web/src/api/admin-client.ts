import type {
  AdminMeResponse,
  ExamDetailResponse,
  ExamListItem,
  ExamPackageListItem,
  GeneratedCandidate,
  GradingJobView,
  SessionDetailResponse,
} from '@ai-measurement/shared';
import { apiRequest, apiUpload } from './http';

const base = '/api/admin';

export const adminApi = {
  login: (username: string, password: string) => apiRequest<AdminMeResponse>('POST', `${base}/login`, { username, password }),
  logout: () => apiRequest<Record<string, never>>('POST', `${base}/logout`, {}),
  me: () => apiRequest<AdminMeResponse>('GET', `${base}/me`),
  packages: () => apiRequest<ExamPackageListItem[]>('GET', `${base}/exam-packages`),
  importDirectory: (slug: string) => apiRequest<{ examId: string; replaced: boolean }>('POST', `${base}/exams/import-directory`, { slug }),
  importZip: (file: File) => apiUpload<{ examId: string; slug: string }>(`${base}/exams/import-zip`, file, 'application/zip'),
  exams: () => apiRequest<ExamListItem[]>('GET', `${base}/exams`),
  exam: (examId: string) => apiRequest<ExamDetailResponse>('GET', `${base}/exams/${examId}`),
  changeStatus: (examId: string, status: 'open' | 'closed') => apiRequest<Record<string, never>>('POST', `${base}/exams/${examId}/status`, { status }),
  generateCandidates: (examId: string, prefix: string, count: number) =>
    apiRequest<GeneratedCandidate[]>('POST', `${base}/exams/${examId}/candidates`, { prefix, count }),
  createGradingJob: (examId: string, llmMode: 'direct' | 'batch') => apiRequest<GradingJobView>('POST', `${base}/exams/${examId}/grading-jobs`, { llmMode }),
  scoresCsvUrl: (examId: string) => `${base}/exams/${examId}/scores.csv`,
  session: (sessionId: string) => apiRequest<SessionDetailResponse>('GET', `${base}/sessions/${sessionId}`),
  sessionExportUrl: (sessionId: string) => `${base}/sessions/${sessionId}/export.json`,
  extend: (sessionId: string, minutes: number, reason: string) =>
    apiRequest<{ expiresAt: string }>('POST', `${base}/sessions/${sessionId}/extend`, { minutes, reason }),
  refund: (sessionId: string, messageId: string, reason: string) =>
    apiRequest<{ tokenBalance: number }>('POST', `${base}/sessions/${sessionId}/refund`, { messageId, reason }),
};
