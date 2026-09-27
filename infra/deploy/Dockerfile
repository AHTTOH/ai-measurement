# 수험생 서버·관리자 서버·채점 워커가 함께 쓰는 이미지(2026-09-27, 결정 D18).
# Cloud Run 서비스마다 실행 명령만 다르게 준다. 빌드 맥락은 저장소 루트다(infra/deploy/cloudbuild.yaml).
FROM node:24-slim

WORKDIR /app

# 의존성 먼저(소스가 바뀌어도 이 층은 캐시된다)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY infra/package.json infra/
COPY server/package.json server/
COPY grading/package.json grading/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund

COPY . .
# 수험생 웹(web/dist/candidate)과 관리자 웹(web/dist/admin)을 빌드한다. Firebase Hosting에도 같은 결과를 올린다
RUN npm run build:web

ENV NODE_ENV=production
# 기본은 수험생 서버. 관리자 서버와 채점 워커는 Cloud Run에서 --args로 바꾼다
ENTRYPOINT ["node", "--import", "tsx"]
CMD ["server/src/candidate-main.ts"]
