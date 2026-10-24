FROM node:20-slim
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY server/src server/src
COPY site site
COPY contracts/verifier/defuse.sha256 contracts/verifier/defuse.sha256
ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/src/index.mjs"]
