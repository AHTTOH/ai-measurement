import type {
  AnswerContent,
  AttachmentSpec,
  CandidateStateResponse,
  ClientEventRequest,
  ConversationDetailResponse,
  ConversationProgressResponse,
  ConversationSummary,
  MaterialPreviewResponse,
  SaveAnswerResponse,
  SendMessageResponse,
} from '@ai-measurement/shared';
import { apiRequest } from './http';

const base = '/api/candidate';

export const candidateApi = {
  login: (candidateNo: string, pin: string) => apiRequest<{ candidateNo: string }>('POST', `${base}/login`, { candidateNo, pin }),
  logout: () => apiRequest<Record<string, never>>('POST', `${base}/logout`, {}),
  state: () => apiRequest<CandidateStateResponse>('GET', `${base}/state`),
  start: () => apiRequest<CandidateStateResponse>('POST', `${base}/session/start`, {}),
  submitExam: () => apiRequest<CandidateStateResponse>('POST', `${base}/session/submit`, {}),
  event: (event: ClientEventRequest) => apiRequest<Record<string, never>>('POST', `${base}/events`, event),
  saveAnswer: (subquestionKey: string, content: AnswerContent) =>
    apiRequest<SaveAnswerResponse>('PUT', `${base}/answers/${encodeURIComponent(subquestionKey)}`, { content }),
  submitAnswer: (subquestionKey: string, content: AnswerContent) =>
    apiRequest<SaveAnswerResponse>('POST', `${base}/answers/${encodeURIComponent(subquestionKey)}/submit`, { content }),
  materialPreview: (caseKey: string, materialKey: string) =>
    apiRequest<MaterialPreviewResponse>('GET', `${base}/cases/${caseKey}/materials/${materialKey}/preview`),
  materialFileUrl: (caseKey: string, materialKey: string) => `${base}/cases/${caseKey}/materials/${materialKey}/file`,
  newConversation: (caseKey: string) => apiRequest<ConversationSummary>('POST', `${base}/conversations`, { caseKey }),
  conversation: (conversationId: string) => apiRequest<ConversationDetailResponse>('GET', `${base}/conversations/${conversationId}`),
  sendMessage: (conversationId: string, body: { clientMessageId: string; subquestionKey: string | null; text: string; attachments: AttachmentSpec[] }) =>
    apiRequest<SendMessageResponse>('POST', `${base}/conversations/${conversationId}/messages`, body),
  progress: (conversationId: string) => apiRequest<ConversationProgressResponse>('GET', `${base}/conversations/${conversationId}/progress`),
};
