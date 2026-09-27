#!/usr/bin/env bash
# Cloud Run 배포(2026-09-27, 결정 D18). 저장소 루트에서 실행: bash infra/deploy/deploy-cloud.sh <이미지>
# 이미지는 먼저 빌드한다: gcloud builds submit --config infra/deploy/cloudbuild.yaml --substitutions=_IMAGE=<이미지> .
# 시크릿(DB 비밀번호, API 키)은 Secret Manager에 있고, 서비스마다 자기 것만 읽는다.
set -euo pipefail
# Windows Git Bash가 /exams 같은 인자를 Windows 경로로 바꾸지 않게 한다
export MSYS2_ARG_CONV_EXCL="volume=;DATABASE_HOST="

IMAGE="${1:?이미지 주소를 첫 인자로 주십시오}"
PROJECT=draw-quiz-prod2
REGION=asia-northeast3
BUCKET=aim-exams-${PROJECT}
SA_SUFFIX=${PROJECT}.iam.gserviceaccount.com

# 두 서버와 워커가 같이 쓰는 DB 접속(Supabase 풀러 세션 모드, 결정 D17)
DB_ENV="DATABASE_HOST=aws-0-ap-northeast-2.pooler.supabase.com,DATABASE_PORT=5432,DATABASE_NAME=postgres,DATABASE_SSL=require,DATABASE_POOLER_PROJECT_REF=jbsmrwkeprsxrvtyblin"
# Firebase Hosting 뒤: 쿠키는 __session만 전달되고, 원래 주소는 x-forwarded-host로 온다
LOGIN_ENV="COOKIE_SECURE=true,AUTH_SESSION_HOURS=12,LOGIN_MAX_FAILURES=5,LOGIN_LOCK_MINUTES=15,LOGIN_ATTEMPTS_PER_IP_PER_MINUTE=600,REQUEST_HOST_HEADER=x-forwarded-host"
EXAMS_VOLUME=(--execution-environment=gen2 --add-volume "name=exams,type=cloud-storage,bucket=${BUCKET}" --add-volume-mount "volume=exams,mount-path=/exams")

# 수험생 서버: 1대 상시(DB 알림 구독·만료 세션 정리), CPU 상시 할당. Supabase 무료 풀러는 계정당 동시 연결 15개라
# 배포 중 옛 버전과 새 버전이 겹쳐도(각 6+1개) 넘지 않게 1대·6개로 둔다(2026-09-27 배포 중 한도 초과로 확인).
# 최소 대수는 0이다(요청이 없으면 요금 없음, 2026-09-27 신영환 지시). 시험·시연 때는 예약 작업이나 수동으로 1로 올린다
gcloud run deploy aim-candidate --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "aim-candidate@${SA_SUFFIX}" --allow-unauthenticated --port 8080 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 1Gi --concurrency 250 --timeout 3600 \
  "${EXAMS_VOLUME[@]}" \
  --args server/src/candidate-main.ts \
  --set-env-vars "${DB_ENV},${LOGIN_ENV},CANDIDATE_SERVER_DB_USER=aim_candidate_login,CANDIDATE_SERVER_HOST=0.0.0.0,CANDIDATE_SERVER_PORT=8080,CANDIDATE_SESSION_COOKIE=__session,CANDIDATE_SERVER_DB_MAX_CONNECTIONS=6,CANDIDATE_WEB_DIST_DIR=/app/web/dist/candidate,EXAMS_DIR=/exams,AI_PROVIDER=anthropic,CANDIDATE_AI_REQUESTS_PER_MINUTE=20,SESSION_SWEEP_SECONDS=15" \
  --set-secrets "CANDIDATE_SERVER_DB_PASSWORD=aim-candidate-db-password:latest,ANTHROPIC_API_KEY=aim-anthropic-api-key:latest"

# 관리자 서버: 필요할 때만 뜬다. 시험 패키지 zip 업로드를 위해 버킷에 쓸 수 있다
gcloud run deploy aim-admin --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "aim-admin@${SA_SUFFIX}" --allow-unauthenticated --port 8080 \
  --min-instances 0 --max-instances 1 --cpu 1 --memory 1Gi --timeout 300 \
  "${EXAMS_VOLUME[@]}" \
  --args server/src/admin-main.ts \
  --set-env-vars "${DB_ENV},${LOGIN_ENV},ADMIN_SERVER_DB_USER=aim_admin_login,ADMIN_SERVER_HOST=0.0.0.0,ADMIN_SERVER_PORT=8080,ADMIN_SESSION_COOKIE=__session,ADMIN_SERVER_DB_MAX_CONNECTIONS=3,ADMIN_WEB_DIST_DIR=/app/web/dist/admin,EXAMS_DIR=/exams,GRADING_LLM_PROVIDER=anthropic,UPLOAD_MAX_MB=50" \
  --set-secrets "ADMIN_SERVER_DB_PASSWORD=aim-admin-db-password:latest"

# 채점 워커: 외부 공개 안 함. 켜져 있는 동안 채점 큐를 본다. 최소 0대라 채점할 때는 1로 올려야 한다
gcloud run deploy aim-grading --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --service-account "aim-grading@${SA_SUFFIX}" --no-allow-unauthenticated --port 8080 \
  --min-instances 0 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 1Gi \
  "${EXAMS_VOLUME[@]}" \
  --args grading/src/worker-main.ts \
  --set-env-vars "${DB_ENV},GRADING_WORKER_DB_USER=aim_grading_login,GRADING_WORKER_DB_MAX_CONNECTIONS=3,EXAMS_DIR=/exams,GRADING_LLM_PROVIDER=anthropic,GRADING_POLL_SECONDS=5,GRADING_BATCH_POLL_SECONDS=60,GRADING_DIRECT_CONCURRENCY=4,GRADING_JOB_LOCK_MINUTES=30,GRADING_WORKER_HEALTH_PORT=8080" \
  --set-secrets "GRADING_WORKER_DB_PASSWORD=aim-grading-db-password:latest,ANTHROPIC_API_KEY=aim-anthropic-api-key:latest"
