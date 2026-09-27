-- 수험생 서버 다중 인스턴스 조정 테이블 권한(결정: docs/decisions/2026-09-27-수험생-서버-다중-인스턴스.md).
-- 두 테이블은 기록이 아니라 조정용 임시 상태이므로 수험생 서버가 지우고 고칠 수 있다. 다른 역할은 쓰지 않는다.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_streams TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON rate_limit_hits TO aim_candidate_server;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE rate_limit_hits_id_seq TO aim_candidate_server;
