<#
.SYNOPSIS
  E2E hesap birikimi temizligi (gelistirme-3 #2c) - YALNIZ dev ortami.

.DESCRIPTION
  Her Playwright kosumu worker basina kalici bir e2e-{stamp}@videoedit.test hesabi ve
  onun asset/proje/revizyon/job satirlarini + MinIO objelerini birakir (fixtures/test.ts,
  worker-scope account). Bu betik o birikimi dev Postgres + dev MinIO'dan temizler.

  BILINCLI TASARIM SINIRLARI:
   - URUNDE kullanici-silme ucu YOKTUR ve bu betik acmaz - prod yuzeyi buyutulmez.
     Temizlik docker exec ile DOGRUDAN dev konteynerlerine yapilir.
   - Playwright globalTeardown'a BAGLANMAZ (varsayilan: elle/periyodik kosum) - gerekce
     docs/SKILLS.md "e2e-hesap-temizligi" girdisi + DECISIONS satiri.
   - Betigin baglanti dizesi parametresi YOKTUR: hedef daima compose.dev.yml'nin
     videoedit-postgres-1 / videoedit-minio-1 konteynerleridir. Prod baglanti dizesine
     karsi fail-fast, "baska hedef ifade edilemez" ile saglanir; ek olarak konteynerin
     compose config'i compose.dev.yml olmali ve DB adi 'videoedit' donmelidir.

  KORUMA (fail-fast, silmeden ONCE):
   - Aday e-postalar SABIT desenden gelir: ^e2e-(auth-)?[a-z0-9]+@videoedit\.test$
   - demo@videoedit.test ya da desene uymayan HERHANGI bir aday gorulurse hicbir sey
     silinmeden cikilir (exit 2). SQL tarafinda da ayni LIKE + demo dislamasi tekrarlanir
     (cifte kilit).

.PARAMETER DryRun
  Yalniz sayim ve aday listesi raporlar; DB/MinIO'ya dokunmaz.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\cleanup-e2e.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\cleanup-e2e.ps1
#>
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$PgContainer = 'videoedit-postgres-1'
$MinioContainer = 'videoedit-minio-1'
$DbName = 'videoedit'
$DbUser = 'app'
# Iki uretici var: fixtures/test.ts -> e2e-{Date.now(36)}{rand(36)}@videoedit.test;
# auth.spec.ts -> e2e-auth-{stamp}@videoedit.test. Ikinci kilit tam bu birlesimdir.
$EmailSqlPattern = 'e2e-%@videoedit.test'
$EmailStrictRegex = '^e2e-(auth-)?[a-z0-9]+@videoedit\.test$'
$ProtectedEmail = 'demo@videoedit.test'
$MediaBucket = 'videoedit-media'
$ExportsBucket = 'videoedit-exports'

function Invoke-Psql([string]$Sql) {
    $out = $Sql | docker exec -i $PgContainer psql -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -t -A -F '|'
    if ($LASTEXITCODE -ne 0) { throw "psql basarisiz (exit ${LASTEXITCODE}): $out" }
    return @($out | Where-Object { $_ -ne '' })
}

Write-Host "== E2E hesap temizligi (dev) ==" -ForegroundColor Cyan

# -- 1) Fail-fast kapilar: dogru konteyner + dogru DB (yanlis/prod hedefe karsi).
# Etiket anahtari nokta icerdigi icin '{{ index ... "anahtar" }}' yerine json cikti alinir:
# PS 5.1 native arg gecisinde ic tirnaklar yutulur ve docker template'i parse edilemezdi.
$labelsJson = docker inspect -f '{{ json .Config.Labels }}' $PgContainer 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "Postgres konteyneri '$PgContainer' bulunamadi - dev ortami ayakta mi? (docker compose -f compose.dev.yml up -d)"
    exit 1
}
$composeFiles = [string](($labelsJson | ConvertFrom-Json).'com.docker.compose.project.config_files')
if ($composeFiles -notmatch 'compose\.dev\.yml') {
    Write-Error "GUVENLIK: '$PgContainer' compose.dev.yml'den gelmiyor (config: $composeFiles). Bu betik YALNIZ dev altyapisina karsi calisir; cikiliyor."
    exit 1
}
$dbCheck = Invoke-Psql "SELECT current_database();"
if ($dbCheck -ne $DbName) {
    Write-Error "GUVENLIK: beklenen DB '$DbName', bulunan '$dbCheck' - cikiliyor."
    exit 1
}

# -- 2) Aday hesaplar (SABIT desen) + koruma dogrulamasi.
$candidates = Invoke-Psql "SELECT ""Id"" || '|' || ""Email"" FROM ""AspNetUsers"" WHERE ""Email"" LIKE '$EmailSqlPattern' ORDER BY ""Email"";"
$users = @()
foreach ($line in $candidates) {
    $parts = $line -split '\|'
    $users += [pscustomobject]@{ Id = $parts[0]; Email = $parts[1] }
}

foreach ($u in $users) {
    if ($u.Email -eq $ProtectedEmail -or $u.Email -notmatch $EmailStrictRegex) {
        Write-Error ("GUVENLIK: aday listesinde korunan ya da desen disi hesap var ('{0}') - hicbir sey silinmeden cikiliyor (koruma deseni bozulmus olabilir)." -f $u.Email) -ErrorAction Continue
        exit 2
    }
}

$demoAlive = Invoke-Psql "SELECT count(*) FROM ""AspNetUsers"" WHERE ""Email"" = '$ProtectedEmail';"
Write-Host ("Aday e2e hesabi: {0}  (demo hesabi mevcut: {1})" -f $users.Count, [string]$demoAlive)
if ($users.Count -eq 0) {
    Write-Host "Temizlenecek e2e hesabi yok; cikiliyor." -ForegroundColor Green
    exit 0
}

# -- 3) Once sayimlar + MinIO prefix listeleri (DB silinince proje id'leri kaybolur).
$idList = ($users | ForEach-Object { "'" + $_.Id + "'" }) -join ','
$before = Invoke-Psql @"
SELECT 'users|'     || count(*) FROM "AspNetUsers" WHERE "Id" IN ($idList)
UNION ALL SELECT 'projects|'  || count(*) FROM "Projects" WHERE "OwnerId" IN ($idList)
UNION ALL SELECT 'revisions|' || count(*) FROM "ProjectRevisions" WHERE "ProjectId" IN (SELECT "Id" FROM "Projects" WHERE "OwnerId" IN ($idList))
UNION ALL SELECT 'assets|'    || count(*) FROM "Assets" WHERE "OwnerId" IN ($idList)
UNION ALL SELECT 'jobs|'      || count(*) FROM "Jobs" WHERE "RequestedBy" IN ($idList);
"@
Write-Host "Silinecek satirlar:"
$before | ForEach-Object { Write-Host ("  " + ($_ -replace '\|', ': ')) }

# Export objesi yalniz OutputKey yazilmis (basarili) islerde vardir — binlerce bos proje
# prefix'ini mc'ye tasimak yerine yalniz gercekten obje birakmis projeler supurulur.
$exportProjectIds = Invoke-Psql "SELECT DISTINCT ""ProjectId"" FROM ""Jobs"" WHERE ""RequestedBy"" IN ($idList) AND ""OutputKey"" IS NOT NULL;"

if ($DryRun) {
    Write-Host "DryRun: DB/MinIO'ya dokunulmadi." -ForegroundColor Yellow
    exit 0
}

# -- 4) DB temizligi - tek transaction; SQL tarafinda da desen + demo dislamasi (cifte kilit).
$deleteSql = @"
BEGIN;
CREATE TEMP TABLE doomed_users ON COMMIT DROP AS
  SELECT "Id" FROM "AspNetUsers"
  WHERE "Email" LIKE '$EmailSqlPattern' AND "Email" <> '$ProtectedEmail';
DELETE FROM "Jobs" WHERE "RequestedBy" IN (SELECT "Id" FROM doomed_users);
DELETE FROM "Projects" WHERE "OwnerId" IN (SELECT "Id" FROM doomed_users); -- revisions + project_assets CASCADE
DELETE FROM "Assets" WHERE "OwnerId" IN (SELECT "Id" FROM doomed_users);   -- kalan project_assets CASCADE
DELETE FROM "AspNetUsers" WHERE "Id" IN (SELECT "Id" FROM doomed_users);   -- refresh token + identity CASCADE
COMMIT;
"@
Invoke-Psql $deleteSql | Out-Null
Write-Host "DB satirlari silindi." -ForegroundColor Green

# -- 5) MinIO temizligi: kullanici prefix'leri (medya) + proje prefix'leri (export ciktilari).
docker exec $MinioContainer mc alias set videoedit-dev http://localhost:9000 videoedit devpassword123 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "MinIO konteynerine ulasilamadi - DB temiz ama objeler kaldi (bunlari lifecycle SUPURMEZ, betigi tekrar kosun)."
    exit 1
}
$prefixes = @()
$prefixes += $users | ForEach-Object { "videoedit-dev/$MediaBucket/u/$($_.Id)/" }
$prefixes += $exportProjectIds | ForEach-Object { "videoedit-dev/$ExportsBucket/exports/$_/" }
for ($i = 0; $i -lt $prefixes.Count; $i += 40) {
    $chunk = $prefixes[$i..([Math]::Min($i + 39, $prefixes.Count - 1))]
    # Var olmayan prefix mc rm'de hata verir - bu baglamda basaridir (silinecek sey yok);
    # cikti bastirilir, exit code'a bakilmaz.
    docker exec $MinioContainer mc rm --recursive --force @chunk 2>$null | Out-Null
}
Write-Host ("MinIO: {0} prefix supuruldu ({1} kullanici medyasi + {2} proje exportu)." -f $prefixes.Count, $users.Count, $exportProjectIds.Count) -ForegroundColor Green

# -- 6) Dogrulama: adaylar gitti, demo duruyor.
$after = Invoke-Psql "SELECT count(*) FROM ""AspNetUsers"" WHERE ""Email"" LIKE '$EmailSqlPattern';"
$demoAfter = Invoke-Psql "SELECT count(*) FROM ""AspNetUsers"" WHERE ""Email"" = '$ProtectedEmail';"
if ([string]$after -ne '0') { Write-Error "Temizlik eksik: hala $after e2e hesabi var."; exit 1 }
if ([string]$demoAfter -ne [string]$demoAlive) { Write-Error "GUVENLIK IHLALI: demo hesabi sayisi degisti ($demoAlive -> $demoAfter)!"; exit 3 }
Write-Host ("Bitti: {0} e2e hesabi ve tum verileri silindi; demo@videoedit.test duruyor." -f $users.Count) -ForegroundColor Green
