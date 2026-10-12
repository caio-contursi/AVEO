FROM node:22-bookworm-slim
WORKDIR /service
COPY ops/rpc-proxy/server.mjs ./server.mjs
USER 1002:1002
EXPOSE 8787
CMD ["node", "server.mjs"]
