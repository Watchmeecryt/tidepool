# ---- docs: static export built with Node 22 ----
FROM node:22-slim AS docs
WORKDIR /app/docs
COPY docs/package*.json ./
RUN npm ci
COPY docs/ ./
COPY site/public/openapi.json /app/site/public/openapi.json
RUN npm run build

# ---- server ----
FROM node:20-slim
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY server/src server/src
COPY docs/brand.json docs/brand.json
COPY site site
COPY contracts/verifier/defuse.sha256 contracts/verifier/defuse.sha256
COPY --from=docs /app/docs/out docs/out
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/src/index.mjs"]
