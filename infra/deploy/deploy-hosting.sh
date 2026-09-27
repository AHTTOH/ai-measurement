#!/usr/bin/env bash
# Firebase Hosting 배포(2026-09-27, 결정 D18). 저장소 루트에서 실행: bash infra/deploy/deploy-hosting.sh
# Firebase는 설정 파일 폴더 밖을 올리지 못하므로 웹 빌드를 infra/deploy/.hosting에 복사해 올린다(git 제외).
set -euo pipefail
npm run build:web
rm -rf infra/deploy/.hosting
mkdir -p infra/deploy/.hosting
cp -r web/dist/candidate infra/deploy/.hosting/candidate
cp -r web/dist/admin infra/deploy/.hosting/admin
cd infra/deploy
firebase deploy --only hosting --config firebase.json --project draw-quiz-prod2 --non-interactive
