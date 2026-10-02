FROM golang:1.26.8-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY web ./web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /sync .

FROM alpine:3.23
RUN addgroup -g 10001 sync && adduser -D -u 10001 -G sync sync \
    && mkdir /data && chown sync:sync /data
COPY --from=build /sync /usr/local/bin/sync
USER 10001:10001
ENV SYNC_DATA=/data SYNC_ADDR=:8080
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD ["/usr/local/bin/sync", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/sync"]
