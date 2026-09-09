# VideoEdit.Worker — multi-stage build (Hangfire server + ffmpeg)
# Build context: ./backend (compose.yml'de tanimli)

# ---------- ffmpeg (SURUM SABITLI) ----------
# Statik ffmpeg 8.0, DIGEST ile sabitli (etiket yeniden isaretlenemez).
# Neden: golden kareler, raster golden'lar ve ses paritesi tablosu TEK bir surume
# kalibre. 2026-09-09'a kadar burada `apt-get install ffmpeg` vardi ve OLCULDU:
# dotnet/runtime:10.0 imajinda apt **ffmpeg 6.1.1** veriyor — yani test edilen (8.0)
# ile URETILEN (6.1.1) iki major surum ayriydi.
FROM mwader/static-ffmpeg@sha256:415a41fa3167b890b9703d20bd0f00bf1e9dab8a4b6c27fef1445b2bf5f1ab4a AS ffmpeg

# ---------- build ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore katmani: sln'nin 8 uyesinin TAMAMI (Api/Dockerfile ile ayni gerekce — sln kopyalanip
# uyeleri eksik birakilirsa sln-duzeyinde calisan her komut build asamasinda kirilir).
COPY VideoEdit.sln ./
COPY src/VideoEdit.Api/VideoEdit.Api.csproj              src/VideoEdit.Api/
COPY src/VideoEdit.Worker/VideoEdit.Worker.csproj        src/VideoEdit.Worker/
COPY src/VideoEdit.Domain/VideoEdit.Domain.csproj        src/VideoEdit.Domain/
COPY src/VideoEdit.Infrastructure/VideoEdit.Infrastructure.csproj src/VideoEdit.Infrastructure/
COPY src/VideoEdit.Media/VideoEdit.Media.csproj          src/VideoEdit.Media/
COPY src/VideoEdit.Contracts/VideoEdit.Contracts.csproj  src/VideoEdit.Contracts/
COPY tools/SchemaGen/SchemaGen.csproj                    tools/SchemaGen/
COPY tests/VideoEdit.UnitTests/VideoEdit.UnitTests.csproj tests/VideoEdit.UnitTests/
RUN dotnet restore src/VideoEdit.Worker/VideoEdit.Worker.csproj

COPY . .
RUN dotnet publish src/VideoEdit.Worker/VideoEdit.Worker.csproj -c Release -o /app/publish /p:UseAppHost=false

# ---------- final ----------
# runtime (aspnet degil — worker HTTP sunmaz). Debian tabanli imaj: apt ile ffmpeg.
FROM mcr.microsoft.com/dotnet/runtime:10.0 AS final

# ffmpeg: proxy/filmstrip/waveform/export islemleri.
# KARAR: audiowaveform paketi Debian depolarinda YOK (imaj build edilemiyordu) — bagimlilik
# tamamen kaldirildi. Waveform peaks.json M1'de .NET icinde uretilecek:
# ffmpeg ile PCM decode -> C# tarafinda downsample (bkz. docs/design/02 §3.5 alternatifi).
# SURUM SABITLENDI (2026-09-09, kullanici karari): apt yerine yukaridaki digest'li
# statik 8.0 imajindan KOPYALANIYOR. Eski notun "MVP icin apt yeterli" varsayimi
# olcumle curudu (apt = 6.1.1, korpus = 8.0).
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

WORKDIR /app
COPY --from=build /app/publish .

# /data: scratch + asset LRU cache (compose'ta worker_data volume'u).
# Non-root 'app' yazabilsin diye dizin USER'dan ONCE olusturulup sahiplenilir — adsiz/yeni
# volume imajdaki sahipligi devralir. NOT: root doneminden kalan MEVCUT bir worker_data
# volume'u root sahipli kalir; boyle bir kurulumda bir kez
# `docker compose run --user root worker chown -R app:app /data` gerekir (deploy/README).
RUN mkdir -p /data && chown -R app:app /data
VOLUME ["/data"]

# Metin/şekil rasteri için küratörlü font seti (rendering-semantics §7). TTF'ler depoya girmez
# ve build context'i ./backend olduğu icin imaja da gomulmez; kalici volume'a kurulur:
#   OUTPUT_ROOT=/data/fonts ./fonts/fetch-fonts.sh
# Fontlar yoksa worker acilista UYARIR (dusmez); yalniz metin klibi iceren export
# 'font-missing' ile deterministik olarak basarisiz olur. Bkz. fonts/README.md.
ENV VIDEOEDIT_FONT_ROOT=/data/fonts

# Container hardening: root olarak KOSULMAZ (ffmpeg kullanicidan gelen medyayi acar — en cok
# sertlestirme hak eden surec budur). 'app' .NET imajlarinin yerlesik kullanicisidir.
USER app

ENTRYPOINT ["dotnet", "VideoEdit.Worker.dll"]
