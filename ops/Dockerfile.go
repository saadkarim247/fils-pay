# Image for the Go settlement service (daemon / CLI). Build context is the repo root.
FROM golang:1.22-bookworm AS build

WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
# timetzdata embeds the zone database: the service loads Asia/Bahrain at
# startup and panics if the zone can't be found.
RUN CGO_ENABLED=0 go build -tags timetzdata -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
