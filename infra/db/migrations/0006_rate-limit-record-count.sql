-- 로그인 실패를 기록하고 창 안의 실패 수를 세는 일을 한 번에 한다(2026-09-27 다중 인스턴스 코드 리뷰).
-- 기록과 세기를 따로 하면 두 서버가 동시에 실패를 기록할 때 서로의 기록을 못 보고 잠금 기준을 넘길 수 있다.
-- rate_limit_try_acquire와 같이 버킷 잠금 뒤 새 스냅숏으로 센다. 커밋은 디스크 기록을 기다리지 않는다(임시 상태).
CREATE FUNCTION rate_limit_record_and_count(p_bucket text, p_since timestamptz, p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  recent integer;
BEGIN
  PERFORM set_config('synchronous_commit', 'off', true);
  PERFORM pg_advisory_xact_lock(hashtext(p_bucket));
  INSERT INTO rate_limit_hits (bucket, at) VALUES (p_bucket, p_at);
  SELECT count(*) INTO recent FROM rate_limit_hits WHERE bucket = p_bucket AND at > p_since;
  RETURN recent;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION rate_limit_record_and_count(text, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_record_and_count(text, timestamptz, timestamptz) TO aim_candidate_server;
