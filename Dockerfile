# syntax=docker/dockerfile:1.7
#
# TRANSITIONAL. Production is moving to App Engine (app.yaml, see DEPLOYMENT.md),
# which needs no container. This file exists so the CURRENT Coolify deployment keeps
# building from master while that cutover happens. Delete it, docker-compose.yml and
# docker-compose.coolify.yml once traffic is on GAE and verified (#68).
#
# Single stage — there is no build step any more. src/ is what runs.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
# Tests ship ava/esmock, which --omit=dev did not install — they must not be in the
# image, and nothing in it runs them.
RUN rm -rf src/tests
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
