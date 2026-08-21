using VideoEdit.Media;

namespace VideoEdit.UnitTests;

/// <summary>
/// .cube doğrulayıcısının dilbilgisi — yükleme hattının LUT kapısı (ProcessAssetJob'un
/// AssetKind.Lut dalı buradan geçirir). Kabul kümesi ffmpeg parse_cube toleransını izler
/// (TITLE/DOMAIN satırları veri arasında bile gelebilir); ret kümesi BİLİNÇLİ daha katıdır
/// (fazladan veri satırı, [0,1] dışı domain) — gerekçeler CubeLutValidator başlığında.
/// </summary>
public class CubeLutValidatorTests
{
    private static CubeLutValidation Validate(string text) =>
        CubeLutValidator.ValidateText(text);

    /// <summary>2³ R↔B takas küpü — ExportJobPipelineTests'in ffmpeg'te ÇALIŞTIĞI ölçülen fixture'ıyla aynı yapı.</summary>
    private static string SwapRedBlueCube()
    {
        var text = new System.Text.StringBuilder();
        text.AppendLine("TITLE \"swap-rb\"");
        text.AppendLine("LUT_3D_SIZE 2");
        text.AppendLine("DOMAIN_MIN 0.0 0.0 0.0");
        text.AppendLine("DOMAIN_MAX 1.0 1.0 1.0");
        for (var b = 0; b < 2; b++)
        {
            for (var g = 0; g < 2; g++)
            {
                for (var r = 0; r < 2; r++)
                {
                    text.AppendLine($"{b}.0 {g}.0 {r}.0");
                }
            }
        }

        return text.ToString();
    }

    [Fact]
    public void Valid2Cube_WithTitleAndDomainAfterSize_Accepted()
    {
        // DOMAIN satırları LUT_3D_SIZE'DAN SONRA — ffmpeg'in tolere ettiği (ve export
        // pipeline testinin gerçek ffmpeg'le ölçtüğü) yerleşim; doğrulayıcı da kabul etmeli.
        var result = Validate(SwapRedBlueCube());
        Assert.True(result.Ok, result.Error);
        Assert.Equal(2, result.Size);
    }

    [Fact]
    public void CommentsBlankLinesAndCrLf_Accepted()
    {
        var text = "# yorum\r\n\r\nLUT_3D_SIZE 2\r\n# veri arasinda yorum\r\n"
            + string.Concat(Enumerable.Repeat("0 0 0\r\n\r\n", 8));
        var result = Validate(text);
        Assert.True(result.Ok, result.Error);
    }

    [Fact]
    public void ScientificNotationAndNegativeValues_Accepted()
    {
        // ffmpeg av_sscanf %f bilimsel gösterimi ve negatifleri okur; float parse da okumalı.
        var rows = string.Concat(Enumerable.Repeat("1e-3 -0.25 0.999999\n", 8));
        var result = Validate($"LUT_3D_SIZE 2\n{rows}");
        Assert.True(result.Ok, result.Error);
    }

    [Fact]
    public void MissingSizeLine_Rejected()
    {
        var result = Validate("0 0 0\n");
        Assert.False(result.Ok);
        Assert.Contains("LUT_3D_SIZE", result.Error);
    }

    [Fact]
    public void Lut1d_RejectedWithTypedMessage()
    {
        var result = Validate("LUT_1D_SIZE 4\n0\n0.33\n0.66\n1\n");
        Assert.False(result.Ok);
        Assert.Contains("1D", result.Error);
    }

    [Theory]
    [InlineData(1)] // < MinSize
    [InlineData(130)] // > MaxSize (önizleme tampon sınırı — gerekçe doğrulayıcı başlığında)
    [InlineData(0)]
    [InlineData(-3)]
    public void SizeOutOfBounds_Rejected(int size)
    {
        var result = Validate($"LUT_3D_SIZE {size}\n0 0 0\n");
        Assert.False(result.Ok);
        Assert.Contains("LUT_3D_SIZE", result.Error);
    }

    [Fact]
    public void TooFewDataRows_Rejected()
    {
        var result = Validate("LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 7)));
        Assert.False(result.Ok);
        Assert.Contains("8", result.Error); // 2³ = 8 beklenir
    }

    [Fact]
    public void ExtraDataRows_Rejected()
    {
        // ffmpeg kuyruğu sessizce yutar; biz "boyutla çelişen dosya" olarak reddederiz.
        var result = Validate("LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 9)));
        Assert.False(result.Ok);
        Assert.Contains("more than", result.Error);
    }

    [Theory]
    [InlineData("0 0")] // 2 bileşen
    [InlineData("0 0 0 0")] // 4 bileşen
    [InlineData("a b c")] // sayı değil
    [InlineData("NaN 0 0")] // sonlu değil
    [InlineData("Infinity 0 0")]
    public void MalformedDataRow_Rejected(string row)
    {
        var result = Validate($"LUT_3D_SIZE 2\n{row}\n");
        Assert.False(result.Ok);
        Assert.Contains("expected 3 finite numbers", result.Error);
    }

    [Fact]
    public void DataRowBeforeSize_Rejected()
    {
        var result = Validate("0.5 0.5 0.5\nLUT_3D_SIZE 2\n");
        Assert.False(result.Ok);
        Assert.Contains("before LUT_3D_SIZE", result.Error);
    }

    [Theory]
    [InlineData("DOMAIN_MIN 0 0 0.1")]
    [InlineData("DOMAIN_MAX 0.9 1 1")]
    [InlineData("DOMAIN_MIN 0 0")] // eksik bileşen de ret
    public void NonUnitDomain_Rejected(string domainLine)
    {
        // Önizleme shader'ı (§4.2) domain ölçeklemesi uygulamaz; ffmpeg uygular —
        // böyle bir dosya kabul edilseydi önizleme ile export ayrışırdı. KAPSAM DIŞI rejim.
        var result = Validate($"LUT_3D_SIZE 2\n{domainLine}\n"
            + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.False(result.Ok);
        Assert.Contains("DOMAIN", result.Error);
    }

    [Fact]
    public void DuplicateSizeLine_Rejected()
    {
        var result = Validate("LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n"
            + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.False(result.Ok);
        Assert.Contains("twice", result.Error);
    }

    // ------------------------------------------------------------------
    // BAYT DİSİPLİNİ (14. tur denetimi BULGU-1): ffmpeg parse_cube ham bayt okur —
    // BOM striplemez, satırı yalnız '\n' ile böler, anahtar kelimeyi 0. bayttan eşler.
    // Buradaki her ret vakası gerçek ffmpeg 8.0 ile ölçüldü (CubeLutFfmpegParityTests
    // aynı korpusu canlı ffmpeg'le çift yönlü sabitler).
    // ------------------------------------------------------------------

    [Theory]
    [InlineData(new byte[] { 0xEF, 0xBB, 0xBF }, "UTF-8")]
    [InlineData(new byte[] { 0xFF, 0xFE }, "UTF-16 LE")]
    [InlineData(new byte[] { 0xFE, 0xFF }, "UTF-16 BE")]
    [InlineData(new byte[] { 0xFF, 0xFE, 0x00, 0x00 }, "UTF-32 LE")]
    [InlineData(new byte[] { 0x00, 0x00, 0xFE, 0xFF }, "UTF-32 BE")]
    public void LeadingBom_Rejected(byte[] bom, string expectedName)
    {
        // BOM'lu dosyada ffmpeg LUT_3D_SIZE'ı hiç görmez → "3D LUT is empty" (exit 183,
        // ffmpeg 8.0 ölçümü). StreamReader'ın sessiz BOM stripine güvenilseydi doğrulayıcı
        // kabul eder, asset Ready olur, export ffmpeg'te patlar — tehlikeli yön buydu.
        var body = System.Text.Encoding.ASCII.GetBytes(CubeLutParityCorpus.CleanBody);
        var result = CubeLutValidator.ValidateBytes([.. bom, .. body]);
        Assert.False(result.Ok);
        Assert.Contains(expectedName, result.Error);
        Assert.Contains("BOM", result.Error);
    }

    [Fact]
    public void Utf16EncodedBody_RejectedEvenBeyondBom()
    {
        // BOM'suz UTF-16 gövde: her karakter arasında NUL baytı vardır — Latin1 bire bir
        // okumada anahtar kelime hiç eşleşmez (ffmpeg'te de eşleşmez). RET.
        var utf16NoBom = System.Text.Encoding.Unicode.GetBytes(CubeLutParityCorpus.CleanBody);
        var result = CubeLutValidator.ValidateBytes(utf16NoBom);
        Assert.False(result.Ok);
    }

    [Fact]
    public void SizeKeywordWithoutWhitespace_Rejected()
    {
        // 'LUT_3D_SIZE2' → ffmpeg 8.0: "Too large or invalid 3D LUT size" (exit 127).
        // Eski StartsWith eşleşmesi argümanı '2' okuyup kabul ediyordu — tehlikeli yön.
        var result = Validate("LUT_3D_SIZE2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.False(result.Ok);
        Assert.Contains("whitespace", result.Error);
    }

    [Fact]
    public void SizeKeywordWithLeadingWhitespace_Rejected()
    {
        // ' LUT_3D_SIZE 2' → ffmpeg anahtar kelimeyi 0. bayttan eşler; öndeki boşlukla satır
        // sıradan satır olarak yutulur, boyut hiç okunmaz → "3D LUT is empty" (ölçüldü).
        var result = Validate(" LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.False(result.Ok);
    }

    [Fact]
    public void DomainKeywordWithoutWhitespace_Rejected()
    {
        // 'DOMAIN_MIN0 0 0' → ffmpeg strncmp(line+7, "MIN ", 4) boşluğu ŞART koşar →
        // AVERROR_INVALIDDATA (ölçüldü). Eski StartsWith bunu domain satırı sanıp geçiyordu.
        var result = Validate("LUT_3D_SIZE 2\nDOMAIN_MIN0 0 0\n"
            + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.False(result.Ok);
    }

    [Fact]
    public void CrOnlyLineEndings_Rejected()
    {
        // Yalnız '\r' ayraçlı dosya ffmpeg (fgets) için TEK satırdır → "Unexpected EOF"
        // (ölçüldü). StreamReader.ReadLine '\r'ı satır sonu saydığı için eski kod kabul
        // ediyordu — tehlikeli yön.
        var text = "LUT_3D_SIZE 2\r" + string.Concat(Enumerable.Repeat("0 0 0\r", 8));
        var result = Validate(text);
        Assert.False(result.Ok);
    }

    [Fact]
    public void TabBetweenKeywordAndArgument_Accepted()
    {
        // 'LUT_3D_SIZE<TAB>2' ffmpeg'te GEÇER (ölçüldü) — boşluk kuralı yalnız 'hiç boşluk
        // yok' durumunu reddeder, sekmeyi değil.
        var result = Validate("LUT_3D_SIZE\t2\n" + string.Concat(Enumerable.Repeat("0 0 0\n", 8)));
        Assert.True(result.Ok, result.Error);
    }

    [Fact]
    public void DataRowsWithLeadingWhitespace_Accepted()
    {
        // Veri satırında önde boşluk ffmpeg sscanf'inde serbesttir (ölçüldü) — kabul.
        var result = Validate("LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat("  0 0 0\n", 8)));
        Assert.True(result.Ok, result.Error);
    }

    [Fact]
    public void TitleWithoutWhitespace_Rejected_DeliberatelyStricter()
    {
        // 'TITLEfoo' ffmpeg'te YUTULUR (strncmp 5) — burada anahtar kelime + boşluk kuralı
        // tekdüze uygulanır ve satır veri satırı olarak reddedilir. GÜVENLİ yönde bilinçli
        // katılık: reddedilen dosya hiç girmez, kabul edilseydi de iki taraf aynı davranırdı.
        var result = Validate("TITLEfoo\n" + CubeLutParityCorpus.CleanBody);
        Assert.False(result.Ok);
    }

    [Fact]
    public void ValidateFile_ReadsRawBytes_BomFileRejected()
    {
        // Dosya yolu üzerinden uçtan uca: ProcessAssetJob'un çağırdığı ValidateFile ham baytı
        // okumalı (StreamReader BOM stripi YOK).
        var path = Path.Combine(Path.GetTempPath(), $"videoedit-bom-{Guid.NewGuid():N}.cube");
        try
        {
            File.WriteAllBytes(path,
            [
                0xEF, 0xBB, 0xBF,
                .. System.Text.Encoding.ASCII.GetBytes(CubeLutParityCorpus.CleanBody),
            ]);
            var result = CubeLutValidator.ValidateFile(path);
            Assert.False(result.Ok);
            Assert.Contains("BOM", result.Error);
        }
        finally
        {
            File.Delete(path);
        }
    }
}

/// <summary>
/// Doğrulayıcı ↔ gerçek ffmpeg lut3d korpusu. Beklenen verdiktler ffmpeg 8.0 ile ölçüldü
/// (2026-08-21, Windows gyan.dev build). SÖZLEŞME YÖNÜ: doğrulayıcının kabul kümesi ffmpeg'in
/// alt kümesi olmak ZORUNDADIR — "validator kabul + ffmpeg ret" tek tehlikeli sınıftır
/// (asset Ready olur, export worker'da patlar); tersi (validator ret + ffmpeg kabul) bilinçli
/// katılıktır ve serbesttir.
/// </summary>
public static class CubeLutParityCorpus
{
    /// <summary>2³ birim küpün en yalın hali — tüm vakaların ortak gövdesi.</summary>
    public const string CleanBody =
        "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n";

    public sealed record Case(string Name, byte[] Bytes, bool ValidatorAccepts, bool FfmpegAccepts);

    public static IReadOnlyList<Case> Cases { get; } = Build();

    private static List<Case> Build()
    {
        var ascii = System.Text.Encoding.ASCII;
        var body = ascii.GetBytes(CleanBody);
        var rows8 = string.Concat(Enumerable.Repeat("0 0 0\n", 8));
        return
        [
            new("clean", body, ValidatorAccepts: true, FfmpegAccepts: true),
            new("utf8_bom", [0xEF, 0xBB, 0xBF, .. body], false, false),
            new("utf16le_bom", [0xFF, 0xFE, .. System.Text.Encoding.Unicode.GetBytes(CleanBody)], false, false),
            new("utf16be_bom", [0xFE, 0xFF, .. System.Text.Encoding.BigEndianUnicode.GetBytes(CleanBody)], false, false),
            new("size_nospace", ascii.GetBytes("LUT_3D_SIZE2\n" + rows8), false, false),
            new("size_leading_ws", ascii.GetBytes(" LUT_3D_SIZE 2\n" + rows8), false, false),
            new("cr_only", ascii.GetBytes("LUT_3D_SIZE 2\r" + string.Concat(Enumerable.Repeat("0 0 0\r", 8))), false, false),
            new("domain_nospace", ascii.GetBytes("LUT_3D_SIZE 2\nDOMAIN_MIN0 0 0\n" + rows8), false, false),
            new("tab_separator", ascii.GetBytes("LUT_3D_SIZE\t2\n" + rows8), true, true),
            new("crlf", ascii.GetBytes(CleanBody.Replace("\n", "\r\n")), true, true),
            new("data_leading_ws", ascii.GetBytes("LUT_3D_SIZE 2\n" + string.Concat(Enumerable.Repeat(" 0 0 0\n", 8))), true, true),
            // Bilinçli-daha-katı vaka: ffmpeg 'TITLEfoo'yu yutar, doğrulayıcı reddeder.
            new("title_nospace", ascii.GetBytes("TITLEfoo\n" + CleanBody), false, true),
        ];
    }
}

/// <summary>
/// Çift yönlü canlı parite: korpusun her vakası hem doğrulayıcıdan hem GERÇEK ffmpeg
/// lut3d'den geçirilir; verdiktler golden beklentiyle VE birbirleriyle karşılaştırılır.
/// ffmpeg PATH'te yoksa Skip (FfmpegTheory).
/// </summary>
public class CubeLutFfmpegParityTests
{
    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in CubeLutParityCorpus.Cases)
        {
            data.Add(c.Name);
        }

        return data;
    }

    [FfmpegTheory]
    [MemberData(nameof(CaseNames))]
    public void ValidatorVerdict_MatchesRealFfmpeg(string caseName)
    {
        var c = CubeLutParityCorpus.Cases.Single(x => x.Name == caseName);

        var validator = CubeLutValidator.ValidateBytes(c.Bytes);
        Assert.Equal(c.ValidatorAccepts, validator.Ok);

        var dir = Directory.CreateTempSubdirectory("videoedit-lut-parity-").FullName;
        try
        {
            // lut3d=file= filtre argümanında Windows sürücü iki noktası kaçış ister; testi
            // dosyanın dizininde koşturup ÇIPLAK adı vermek her platformda aynı davranır.
            var fileName = $"{c.Name}.cube";
            File.WriteAllBytes(Path.Combine(dir, fileName), c.Bytes);
            var ffmpegAccepts = RunLut3d(dir, fileName);
            Assert.Equal(c.FfmpegAccepts, ffmpegAccepts);

            // SÖZLEŞMENİN ASIL DİŞİ: doğrulayıcı kabul ettiyse ffmpeg de KABUL ETMEK
            // ZORUNDA (aksi "Ready ama export patlar" sınıfıdır — BULGU-1'in kendisi).
            if (validator.Ok)
            {
                Assert.True(ffmpegAccepts,
                    $"validator accepted '{c.Name}' but real ffmpeg rejected it — "
                    + "the Ready-set must be a subset of ffmpeg's accept-set.");
            }
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static bool RunLut3d(string workingDir, string cubeFileName)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "ffmpeg",
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var arg in new[]
        {
            "-hide_banner", "-v", "error",
            "-f", "lavfi", "-i", "color=red:size=16x16:duration=0.1:rate=10",
            "-vf", $"lut3d=file={cubeFileName}:interp=trilinear",
            "-frames:v", "1", "-f", "null", "-",
        })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = System.Diagnostics.Process.Start(psi)!;
        // Deadlock önleme: stdout/stderr tüketilmeden WaitForExit pipe dolunca asılabilir.
        process.StandardOutput.ReadToEnd();
        process.StandardError.ReadToEnd();
        if (!process.WaitForExit(60_000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("ffmpeg lut3d probe did not finish in 60 s.");
        }

        return process.ExitCode == 0;
    }
}
