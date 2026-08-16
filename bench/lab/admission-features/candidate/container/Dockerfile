# Frozen linux/amd64 Node 22.22.0 Alpine 3.22 image approved for MEM-002C2.
FROM node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9 AS candidate

ARG CANDIDATE_SHA256
ARG SOURCE_SHA256
LABEL org.memberry.candidate.sha256=${CANDIDATE_SHA256} \
      org.memberry.source.sha256=${SOURCE_SHA256} \
      org.memberry.base.image="node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9"

WORKDIR /app
COPY --chown=65532:65532 container/worker.mjs container/attestation.json /app/

USER 65532:65532
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

ENTRYPOINT ["/usr/local/bin/node"]
CMD ["--permission", "--allow-fs-read=/run/input.json", "--allow-fs-write=/tmp/memberry-sandbox-write-probe", "--disable-proto=throw", "/app/worker.mjs", "/run/input.json"]
