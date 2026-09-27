-- 요청 한도 확인과 기록을 DB 안의 함수 한 번으로 한다(2026-09-27 부하 테스트에서 발견한 병목).
-- 이전에는 버킷 잠금을 잡은 채 서버와 DB가 세 번 왕복해, 한 IP에서 로그인이 몰리면 잠금 대기가 줄지어 쌓였다.
-- 잠금 뒤의 SELECT는 새 스냅숏을 보므로(READ COMMITTED, VOLATILE 함수) 먼저 끝난 기록을 빠짐없이 센다.
-- 이 기록은 조정용 임시 상태라 커밋이 디스크 기록을 기다리지 않게 한다(synchronous_commit off, 이 트랜잭션에만).
CREATE FUNCTION rate_limit_try_acquire(p_bucket text, p_since timestamptz, p_at timestamptz, p_limit integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  recent integer;
BEGIN
  PERFORM set_config('synchronous_commit', 'off', true);
  PERFORM pg_advisory_xact_lock(hashtext(p_bucket));
  SELECT count(*) INTO recent FROM rate_limit_hits WHERE bucket = p_bucket AND at > p_since;
  IF recent >= p_limit THEN
    RETURN false;
  END IF;
  INSERT INTO rate_limit_hits (bucket, at) VALUES (p_bucket, p_at);
  RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION rate_limit_try_acquire(text, timestamptz, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_try_acquire(text, timestamptz, timestamptz, integer) TO aim_candidate_server;
