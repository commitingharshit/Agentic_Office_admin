# The promotion media worker (src/growth/media-worker.ts): Node plus ffmpeg. The source is mounted like the API's, not copied in.
FROM node:24.15.0-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /srv
