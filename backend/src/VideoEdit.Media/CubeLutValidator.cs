using System.Globalization;
using System.Text;

namespace VideoEdit.Media;

/// <summary>Sonuç: geçerliyse <c>Size</c> dolu (N, kenar boyu), değilse <c>Error</c> dolu.</summary>
public sealed record CubeLutValidation(bool Ok, int Size, string? Error)
{
    public static CubeLutValidation Valid(int size) => new(true, size, null);
    public static CubeLutValidation Invalid(string error) => new(false, 0, error);
}

/// <summary>
/// .cube (3D LUT) İÇERİK doğrulayıcısı — yükleme hattının LUT kapısı (ProcessAssetJob,
/// AssetKind.Lut dalı). Bir .cube ffprobe'dan GEÇMEZ; bu doğrulayıcı "worker'ın Ready dediği
/// her .cube'ü hem ffmpeg'in <c>lut3d</c> filtresi hem önizlemenin WebGL yükleyicisi AYNI
/// şekilde okuyabilir" sözleşmesini kurar. Sözleşmenin yönü: burada KABUL edilen küme,
/// ffmpeg'in kabul kümesinin ALT KÜMESİDİR (kabul edilen dosya iki tarafta aynı davranır;
/// reddedilen dosya hatta hiç girmez — "Ready ama export'ta lut3d patlar" durumu OLAMAZ).
///
/// BAYT DİSİPLİNİ (14. tur denetimi, BULGU-1): ffmpeg <c>parse_cube</c> dosyayı HAM BAYT
/// olarak okur (fgets) — BOM striplemez, UTF-16 çözmez, satırları yalnız '\n' ile böler ve
/// anahtar kelimeyi satırın 0. BAYTINDAN eşler. Doğrulayıcı aynı disiplini uygular:
///  - baştaki BOM (UTF-8/16/32) AÇIKÇA RET edilir — ffmpeg'te BOM, LUT_3D_SIZE eşleşmesini
///    bozup "3D LUT is empty" üretir (ffmpeg 8.0 ile ölçüldü); StreamReader'ın sessiz
///    BOM/encoding sezimi KULLANILMAZ, baytlar Latin1 ile bire bir çözülür;
///  - satır ayıracı YALNIZ '\n' (fgets gibi; '\r' satır içi boşluk olarak kalır — yalnız-CR
///    dosya ffmpeg için TEK satırdır ve "Unexpected EOF" ile ölür, burada da RET edilir);
///  - anahtar kelime satırın BAŞINDA olmalı (' LUT_3D_SIZE 2' ffmpeg'te sıradan satır olarak
///    yutulur, boyut hiç okunmaz → "3D LUT is empty"; burada RET) ve kelimeden sonra BOŞLUK
///    ŞARTTIR ('LUT_3D_SIZE2' ffmpeg'te "Too large or invalid 3D LUT size" → burada RET;
///    'DOMAIN_MIN0 0 0' ffmpeg'te AVERROR_INVALIDDATA → burada RET).
///
/// Dilbilgisi ffmpeg'in <c>vf_lut3d.c parse_cube</c> toleransını izler:
///  - '#' yorum ve boş satırlar (önde boşluk olsa da) her yerde atlanır;
///  - <c>TITLE</c>, <c>DOMAIN_MIN</c>, <c>DOMAIN_MAX</c> satırları veri satırlarının
///    ARASINDA bile tolere edilir (ffmpeg aynısını yapar — mevcut export fixture'ı
///    DOMAIN satırlarını LUT_3D_SIZE'dan sonra yazar ve ffmpeg'te çalışır);
///  - veri satırı 3 sonlu float'tır (InvariantCulture; önde boşluk serbest — sscanf gibi),
///    sırası .cube standardı: KIRMIZI en hızlı değişir (r iç döngü) — WebGL 3D dokusunun
///    x ekseniyle birebir.
///
/// ffmpeg'den BİLİNÇLİ olarak DAHA KATI olduğu yerler (güvenli yön — kabul edilen dosya iki
/// tarafta da aynı davranır; reddedilen dosya hiç girmez):
///  - <c>DOMAIN_MIN</c>/<c>DOMAIN_MAX</c> [0,1]'den farklıysa RET: önizleme shader'ı
///    (rendering-semantics §4.2) domain ölçeklemesi uygulamaz; ffmpeg uygular — böyle bir
///    dosya kabul edilseydi önizleme ile export AYRIŞIRDI. Bu rejim KAPSAM DIŞI ilan edildi.
///  - N³ veri satırından SONRA gelen fazladan veri satırı RET: ffmpeg kuyruğu sessizce
///    yutar; sessiz yutma "yanlış boyut yazılmış dosya" hatasını görünmez kılar.
///  - N üst sınırı 129 (ffmpeg 256'ya kadar okur): 129³ RGBA float doku ≈ 34 MB yükleme
///    tamponu — tarayıcıda güvenli üst sınır; 256³ (268 MB) önizlemeyi çökertebilirdi.
///  - Bitişik <c>TITLE</c> ('TITLEfoo') RET: ffmpeg strncmp(…,5) ile yutar; burada anahtar
///    kelime + boşluk kuralı tekdüze uygulanır (gerçek üreticiler 'TITLE "ad"' yazar).
///  - Boyut argümanında kuyruk RET ('LUT_3D_SIZE 2abc', '0x10'): ffmpeg strtol kuyruğu
///    yutar/hex okur; burada argüman düz ondalık tamsayı olmak zorundadır.
/// </summary>
public static class CubeLutValidator
{
    public const int MinSize = 2;

    /// <summary>Üst sınır gerekçesi sınıf yorumunda (önizleme tamponu). ffmpeg 256'ya izin verir.</summary>
    public const int MaxSize = 129;

    public static CubeLutValidation ValidateFile(string path) =>
        ValidateBytes(File.ReadAllBytes(path));

    /// <summary>
    /// Ham baytlar üzerinden doğrulama — ffmpeg'in gördüğü baytların AYNISI değerlendirilir.
    /// BOM'lu dosya burada ölür; kalan baytlar Latin1 ile (bayt→karakter bire bir, sessiz
    /// encoding sezimi yok) metne çevrilip dilbilgisinden geçirilir.
    /// </summary>
    public static CubeLutValidation ValidateBytes(byte[] bytes)
    {
        if (StartsWithBom(bytes, out var bomName))
        {
            return CubeLutValidation.Invalid(
                $"file starts with a {bomName} byte-order mark (BOM) — ffmpeg's lut3d reads raw "
                + "bytes, so the BOM breaks the LUT_3D_SIZE keyword match and the table stays "
                + "empty ('3D LUT is empty'). Save the file as plain ASCII/UTF-8 WITHOUT a BOM.");
        }

        return ValidateText(Encoding.Latin1.GetString(bytes));
    }

    /// <summary>
    /// Dilbilgisi doğrulaması. Satır ayıracı YALNIZ '\n' — ffmpeg'in fgets disiplini ('\r'
    /// satırın içinde kalır ve satır sonu boşluğu olarak kırpılır; yalnız-CR dosya TEK
    /// satırdır ve boyut argümanı bozulduğu için reddedilir, ffmpeg'in yaptığı gibi).
    /// </summary>
    public static CubeLutValidation ValidateText(string text)
    {
        var size = 0;
        long dataRows = 0;
        long lineNo = 0;

        foreach (var rawLine in text.Split('\n'))
        {
            lineNo++;

            // skip_line eşdeğeri: önde boşluk olsa da boş/yorum satırı atlanır.
            var stripped = rawLine.Trim();
            if (stripped.Length == 0 || stripped.StartsWith('#'))
            {
                continue;
            }

            // Anahtar kelimeler HAM satırın 0. karakterinden eşlenir (ffmpeg strncmp(line, …)
            // gibi) — öndeki boşluk kelimeyi kelime olmaktan çıkarır ve satır veri satırı
            // yoluna düşer (orada da reddedilir; ffmpeg böyle satırı boyut olarak OKUMAZ).
            if (TryKeyword(rawLine, "TITLE", out _))
            {
                continue;
            }

            if (rawLine.StartsWith("LUT_1D_SIZE", StringComparison.Ordinal))
            {
                return CubeLutValidation.Invalid(
                    "file declares LUT_1D_SIZE — this is a 1D LUT; the product's lut effect "
                    + "(ffmpeg lut3d + preview sampler3D) requires a 3D LUT (LUT_3D_SIZE).");
            }

            if (TryKeyword(rawLine, "DOMAIN_MIN", out var domainMinArgs))
            {
                if (!IsDomainArgs(domainMinArgs, expected: 0f))
                {
                    return CubeLutValidation.Invalid(
                        $"line {lineNo}: DOMAIN_MIN must be '0 0 0' — the preview shader "
                        + "(rendering-semantics §4.2) does not apply domain scaling, so a "
                        + "non-default domain would make preview and export disagree.");
                }

                continue;
            }

            if (TryKeyword(rawLine, "DOMAIN_MAX", out var domainMaxArgs))
            {
                if (!IsDomainArgs(domainMaxArgs, expected: 1f))
                {
                    return CubeLutValidation.Invalid(
                        $"line {lineNo}: DOMAIN_MAX must be '1 1 1' — the preview shader "
                        + "(rendering-semantics §4.2) does not apply domain scaling, so a "
                        + "non-default domain would make preview and export disagree.");
                }

                continue;
            }

            if (rawLine.StartsWith("LUT_3D_SIZE", StringComparison.Ordinal))
            {
                if (!TryKeyword(rawLine, "LUT_3D_SIZE", out var argument))
                {
                    // 'LUT_3D_SIZE2' gibi bitişik yazım: ffmpeg boyut argümanını anahtar
                    // kelimenin ARKASINDAKİ boşluktan sonra okur ve bu satırı
                    // "Too large or invalid 3D LUT size" ile reddeder (ffmpeg 8.0 ölçümü).
                    return CubeLutValidation.Invalid(
                        $"line {lineNo}: LUT_3D_SIZE must be followed by whitespace before its "
                        + $"argument — ffmpeg rejects '{Truncate(stripped)}' as an invalid size.");
                }

                if (size != 0)
                {
                    return CubeLutValidation.Invalid($"line {lineNo}: LUT_3D_SIZE declared twice.");
                }

                if (!int.TryParse(argument, NumberStyles.Integer, CultureInfo.InvariantCulture, out size)
                    || size < MinSize || size > MaxSize)
                {
                    return CubeLutValidation.Invalid(
                        $"line {lineNo}: LUT_3D_SIZE must be an integer in [{MinSize}, {MaxSize}], "
                        + $"got '{argument}'.");
                }

                continue;
            }

            // Kalan her satır bir VERİ satırı olmak zorundadır: 3 sonlu float (önde boşluk
            // serbest — ffmpeg sscanf'i de yutar).
            if (!TryParseDataRow(stripped))
            {
                return CubeLutValidation.Invalid(
                    $"line {lineNo}: expected 3 finite numbers (a LUT data row), got '{Truncate(stripped)}'.");
            }

            if (size == 0)
            {
                return CubeLutValidation.Invalid(
                    $"line {lineNo}: data row before LUT_3D_SIZE — the table size must be declared first.");
            }

            dataRows++;
            if (dataRows > (long)size * size * size)
            {
                return CubeLutValidation.Invalid(
                    $"line {lineNo}: more than {size}^3 = {(long)size * size * size} data rows — "
                    + "the file does not match its declared LUT_3D_SIZE.");
            }
        }

        if (size == 0)
        {
            return CubeLutValidation.Invalid("no LUT_3D_SIZE line — not a 3D .cube file.");
        }

        var expectedRows = (long)size * size * size;
        return dataRows == expectedRows
            ? CubeLutValidation.Valid(size)
            : CubeLutValidation.Invalid(
                $"expected {expectedRows} data rows (LUT_3D_SIZE {size}), found {dataRows}.");
    }

    private static readonly (byte[] Prefix, string Name)[] Boms =
    [
        // UTF-32 önce: FF FE 00 00, UTF-16LE'nin (FF FE) üst kümesidir.
        ([0xFF, 0xFE, 0x00, 0x00], "UTF-32 LE"),
        ([0x00, 0x00, 0xFE, 0xFF], "UTF-32 BE"),
        ([0xEF, 0xBB, 0xBF], "UTF-8"),
        ([0xFF, 0xFE], "UTF-16 LE"),
        ([0xFE, 0xFF], "UTF-16 BE"),
    ];

    private static bool StartsWithBom(byte[] bytes, out string name)
    {
        foreach (var (prefix, bomName) in Boms)
        {
            if (bytes.Length >= prefix.Length && bytes.AsSpan(0, prefix.Length).SequenceEqual(prefix))
            {
                name = bomName;
                return true;
            }
        }

        name = "";
        return false;
    }

    /// <summary>
    /// Satır <paramref name="keyword"/> ile mi başlıyor VE kelimeden sonra boşluk (ya da satır
    /// sonu) mu geliyor? Evetse <paramref name="args"/> kelimeden sonrasının kırpılmış hali.
    /// 'KEYWORDx' bitişik yazımı KELİME SAYILMAZ (ffmpeg'in boşluk-scanf semantiği).
    /// </summary>
    private static bool TryKeyword(string line, string keyword, out string args)
    {
        args = "";
        if (!line.StartsWith(keyword, StringComparison.Ordinal))
        {
            return false;
        }

        if (line.Length == keyword.Length)
        {
            return true; // yalın kelime, argüman yok — çağıran boş argümanı değerlendirir
        }

        if (!char.IsWhiteSpace(line[keyword.Length]))
        {
            return false;
        }

        args = line[keyword.Length..].Trim();
        return true;
    }

    /// <summary>"0 0 0" biçimindeki domain argümanının üç bileşeni de <paramref name="expected"/> mi?</summary>
    private static bool IsDomainArgs(string args, float expected)
    {
        var parts = args.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 3)
        {
            return false;
        }

        foreach (var part in parts)
        {
            if (!float.TryParse(part, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                || value != expected)
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryParseDataRow(string line)
    {
        var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length != 3)
        {
            return false;
        }

        foreach (var part in parts)
        {
            if (!float.TryParse(part, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                || !float.IsFinite(value))
            {
                return false;
            }
        }

        return true;
    }

    private static string Truncate(string line) =>
        line.Length <= 40 ? line : line[..40] + "…";
}
