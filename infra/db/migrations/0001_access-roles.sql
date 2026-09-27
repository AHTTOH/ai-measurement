-- 권한 구조 분리(결정: docs/decisions/2026-09-27-권한-구조-분리.md)
-- 프로세스마다 다른 역할로 접속한다. 로그인 계정은 scripts/apply-database-logins.ts가 만들고 이 역할에 넣는다.
-- 원칙: 필요한 것만 준다. 대화·원장·답안·감사 로그는 어느 역할도 UPDATE·DELETE할 수 없다(추가만).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aim_candidate_server') THEN CREATE ROLE aim_candidate_server NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aim_admin_server') THEN CREATE ROLE aim_admin_server NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aim_grading_worker') THEN CREATE ROLE aim_grading_worker NOLOGIN; END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO aim_candidate_server, aim_admin_server, aim_grading_worker;
--> statement-breakpoint

-- ── 수험생 서버: 정답·루브릭 컬럼과 관리자·채점 테이블은 읽지 못한다 ──
GRANT SELECT (id, slug, title, status, package_sha256, definition, grading, material_files, imported_by, imported_at, opened_at, closed_at) ON exams TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT ON candidates TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON auth_sessions TO aim_candidate_server;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON auth_sessions TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON exam_sessions TO aim_candidate_server;
--> statement-breakpoint
-- 만료 시각(expires_at)은 바꿀 수 없다. 시간 연장은 관리자 서버만 한다
GRANT UPDATE (status, ended_at) ON exam_sessions TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON conversations TO aim_candidate_server;
--> statement-breakpoint
GRANT UPDATE (status, closed_at) ON conversations TO aim_candidate_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON messages, attachments, attachment_blobs, token_ledger, answers, audit_events TO aim_candidate_server;
--> statement-breakpoint
GRANT INSERT ON client_events TO aim_candidate_server;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE token_ledger_id_seq, audit_events_id_seq, client_events_id_seq TO aim_candidate_server;
--> statement-breakpoint

-- ── 관리자 서버: 정답·루브릭은 등록(쓰기)만 하고 읽지 않는다. 응시 기록은 읽기만 한다 ──
GRANT SELECT (id, slug, title, status, package_sha256, definition, grading, material_files, imported_by, imported_at, opened_at, closed_at) ON exams TO aim_admin_server;
--> statement-breakpoint
GRANT INSERT, UPDATE ON exams TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT ON admins TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON auth_sessions TO aim_admin_server;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON auth_sessions TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON candidates TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT ON exam_sessions TO aim_admin_server;
--> statement-breakpoint
GRANT UPDATE (expires_at) ON exam_sessions TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT ON conversations, messages, attachments, answers, client_events, grade_items, session_scores, violations TO aim_admin_server;
--> statement-breakpoint
GRANT SELECT, INSERT ON token_ledger, audit_events, grading_jobs TO aim_admin_server;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE token_ledger_id_seq, audit_events_id_seq TO aim_admin_server;
--> statement-breakpoint

-- ── 채점 워커: 채점 입력은 읽기만, 채점 결과와 작업 상태만 쓴다 ──
GRANT SELECT ON exams, candidates, exam_sessions, conversations, messages, attachments, answers TO aim_grading_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON grading_jobs TO aim_grading_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON grade_items, violations, session_scores TO aim_grading_worker;
