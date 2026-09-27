/** 테스트·스크립트가 서버를 조립할 때 쓰는 공개 진입점 */
export { buildCandidateApp, CANDIDATE_WEB_INDEX } from './candidate-app';
export { buildCandidateServices, STREAM_HUB_TIMING, type CandidateServices, type CandidateServiceDependencies } from './candidate-services';
export type { StreamHubTiming } from './modules/ai/stream-hub';
export { buildAdminApp, ADMIN_WEB_INDEX } from './admin-app';
export { buildAdminServices, type AdminServices, type AdminServiceDependencies } from './admin-services';
export { loadCandidateServerConfig, type CandidateServerConfig } from './config/candidate-server-config';
export { loadAdminServerConfig, type AdminServerConfig } from './config/admin-server-config';
export { ConfigError, type ListenConfig, type LoginPolicy } from './config/common-config';
export { createAiGateway, type AiGatewaySettings } from './create-ai-gateway';
export type { Clock } from './lib/clock';
export { systemClock } from './lib/clock';
export { consoleLogger, silentLogger, type Logger } from './lib/logger';
export { hashSecret } from './lib/secrets';
export { MockGateway } from './modules/ai/mock-gateway';
export { AiGatewayError, type AiGateway, type AiCompletion, type AiConversationRequest, type AiCountRequest } from './modules/ai/ai-gateway';
