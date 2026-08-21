# VideoEdit.Api — multi-stage build
# Build context: ./backend (compose.yml'de tanimli)
#   docker build -f src/VideoEdit.Api/Dockerfile .

# ---------- build ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore katmani icin once sln + csproj'lar (Docker layer cache).
# Sln'nin 8 uyesinin TAMAMI kopyalanir (SchemaGen + UnitTests dahil): sln kopyalanip uyeleri
# eksik birakilirsa sln-duzeyinde calisan her komut (restore/vbdiger) build asamasinda kirilir
# ve katman onbellegi yaniltici olur.
COPY VideoEdit.sln ./
COPY src/VideoEdit.Api/VideoEdit.Api.csproj              src/VideoEdit.Api/
COPY src/VideoEdit.Worker/VideoEdit.Worker.csproj        src/VideoEdit.Worker/
COPY src/VideoEdit.Domain/VideoEdit.Domain.csproj        src/VideoEdit.Domain/
COPY src/VideoEdit.Infrastructure/VideoEdit.Infrastructure.csproj src/VideoEdit.Infrastructure/
COPY src/VideoEdit.Media/VideoEdit.Media.csproj          src/VideoEdit.Media/
COPY src/VideoEdit.Contracts/VideoEdit.Contracts.csproj  src/VideoEdit.Contracts/
COPY tools/SchemaGen/SchemaGen.csproj                    tools/SchemaGen/
COPY tests/VideoEdit.UnitTests/VideoEdit.UnitTests.csproj tests/VideoEdit.UnitTests/
RUN dotnet restore src/VideoEdit.Api/VideoEdit.Api.csproj

COPY . .
RUN dotnet publish src/VideoEdit.Api/VideoEdit.Api.csproj -c Release -o /app/publish /p:UseAppHost=false

# ---------- final ----------
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final

# curl: compose healthcheck'i icin (CMD curl -fsS http://localhost:8080/health)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

# Container hardening: root olarak KOSULMAZ. .NET imajlari 'app' kullanicisiyla gelir
# (UID 1654 dokumante APP_UID); 8080 ayricaliksiz port oldugu icin baska degisiklik gerekmez.
USER app

ENTRYPOINT ["dotnet", "VideoEdit.Api.dll"]
