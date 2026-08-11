# VideoEdit.Worker — multi-stage build (Hangfire server + ffmpeg)
# Build context: ./backend (compose.yml'de tanimli)

# ---------- build ----------
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY VideoEdit.sln ./
COPY src/VideoEdit.Api/VideoEdit.Api.csproj              src/VideoEdit.Api/
COPY src/VideoEdit.Worker/VideoEdit.Worker.csproj        src/VideoEdit.Worker/
COPY src/VideoEdit.Domain/VideoEdit.Domain.csproj        src/VideoEdit.Domain/
COPY src/VideoEdit.Infrastructure/VideoEdit.Infrastructure.csproj src/VideoEdit.Infrastructure/
COPY src/VideoEdit.Media/VideoEdit.Media.csproj          src/VideoEdit.Media/
COPY src/VideoEdit.Contracts/VideoEdit.Contracts.csproj  src/VideoEdit.Contracts/
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
# NOT: apt surumu distro'ya baglidir — ileride surum sabitlemek icin statik ffmpeg binary'si
# (johnvansickle/BtbN build'leri) COPY ile imaja gomulmeli. MVP icin apt yeterli.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

# /data: scratch + asset LRU cache (compose'ta worker_data volume'u)
VOLUME ["/data"]

# Metin/şekil rasteri için küratörlü font seti (rendering-semantics §7). TTF'ler depoya girmez
# ve build context'i ./backend olduğu icin imaja da gomulmez; kalici volume'a kurulur:
#   OUTPUT_ROOT=/data/fonts ./fonts/fetch-fonts.sh
# Fontlar yoksa worker acilista UYARIR (dusmez); yalniz metin klibi iceren export
# 'font-missing' ile deterministik olarak basarisiz olur. Bkz. fonts/README.md.
ENV VIDEOEDIT_FONT_ROOT=/data/fonts

ENTRYPOINT ["dotnet", "VideoEdit.Worker.dll"]
