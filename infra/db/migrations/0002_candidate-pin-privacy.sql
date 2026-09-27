-- 응시자 PIN 해시는 수험생 서버(로그인 확인)만 읽는다. 2026-09-27 권한 분리 검토에서 발견
-- (결정: docs/decisions/2026-09-27-권한-구조-분리.md). 관리자 서버와 채점 워커는 응시번호만 쓴다.
-- 관리자 서버는 응시자를 발급할 때 pin_hash를 쓰기만 한다(INSERT 권한은 그대로).
REVOKE SELECT ON candidates FROM aim_admin_server, aim_grading_worker;
--> statement-breakpoint
GRANT SELECT (id, exam_id, candidate_no, created_at) ON candidates TO aim_admin_server, aim_grading_worker;
