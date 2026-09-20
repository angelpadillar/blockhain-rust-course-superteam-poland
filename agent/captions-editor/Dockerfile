# Immutable upstream source; patch exposes actual upload/checkbox DOM metadata.
FROM golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36 AS patched-upstream
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:95d53751b09af684217366e7b38b2d5a7fbf909c74759992d5a6bbba7b40eafa https://codeload.github.com/ehmo/gomoufox/tar.gz/98be4f2731d5be8922e83a59191d48358fedddcd /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src
COPY patches/observed-inputs.patch /tmp/observed-inputs.patch
RUN patch -p1 < /tmp/observed-inputs.patch \
    && gofmt -w internal/a11y/a11y.go internal/mcp/gomoufox_session.go \
    && go test ./internal/a11y ./internal/mcp \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X github.com/ehmo/gomoufox/internal/buildinfo.Version=v0.1.29" \
      -o /out/gomoufox ./cmd/gomoufox

FROM ghcr.io/ehmo/gomoufox:v0.1.29@sha256:9f147efac1c5f0684ddb1fda085124454d008cad3a1fc3dd5ebfb615ff02c99c

COPY --from=patched-upstream /out/gomoufox /usr/local/bin/gomoufox

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify fluxbox wmctrl ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o pwuser -g pwuser /app/state /home/pwuser \
    && install -d -m 0755 -o pwuser -g pwuser /app/assets \
    && ln -s /app/assets '/home/pwuser/Buena Uploads' \
    && ln -s /app/assets '/opt/gomoufox/Buena Uploads'
WORKDIR /app
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser scripts ./scripts
COPY --chown=pwuser:pwuser tests ./tests
COPY --chown=pwuser:pwuser config ./config
COPY --chown=pwuser:pwuser novnc ./novnc
RUN node scripts/install-clipboard.mjs
USER pwuser
ENV DISPLAY=:99 NODE_ENV=production
RUN node --test tests/*.test.mjs
ENTRYPOINT ["node"]
CMD ["src/onboarding.mjs"]
