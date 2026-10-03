# The assistant host (src/host): built by scripts/build-host-image.sh, which
# stages the bundle, its worker threads, the CPython-WASM assets, and jq-wasm.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY dist-host/ dist-host/
COPY dist/cpython/ dist/cpython/
COPY node_modules/jq-wasm/ node_modules/jq-wasm/
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist-host/main.mjs"]
