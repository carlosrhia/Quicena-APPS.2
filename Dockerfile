# Dockerfile para publicar Quincena en un hosting gratuito con HTTPS (Render, Railway, Fly.io…)
# La base de datos vive en /data: en Render hay que montar ahí un disco persistente.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY scripts ./scripts
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
