using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using VideoEdit.Domain;
using VideoEdit.Domain.Entities;
using VideoEdit.Infrastructure;
using VideoEdit.Worker.Jobs;

namespace VideoEdit.UnitTests;

/// <summary>
/// ProjectRevisions retention (gelistirme-3 #2b — tasarım 03 "son 50 auto + 24 saatten
/// eskilerde saatte 1'e inceltme; Checkpoint süresiz"). İki katman:
///  - SAF seçici sınır testleri (<see cref="ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete"/>):
///    tam 50'de dokunmaz / 51.'de en eskiyi süpürür / genç koruması / kova inceltmesi /
///    proje izolasyonu;
///  - GERÇEK DB koşumu (Sqlite in-memory, AssetEndpointsTests deseni): Run() yalnız Auto
///    siler, Checkpoint (adlandırılmış) + PreRestore (restore'un tek kurtarma yolu) KALIR;
///  - MUHAFIZ: Worker Program.cs kaynak taraması — iki recurring işin kaydı da sökülemez
///    (CrossUserEndpointInventoryTests'in Program.cs tarama deseni).
/// </summary>
public sealed class RevisionRetentionJobTests : IDisposable
{
    private static readonly RevisionRetentionOptions Defaults = new();

    private readonly SqliteConnection _connection;
    private readonly AppDbContext _db;
    private readonly DateTimeOffset _now = new(2026, 08, 31, 12, 0, 0, TimeSpan.Zero);

    public RevisionRetentionJobTests()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        _connection.Open();
        _db = new AppDbContext(
            new DbContextOptionsBuilder<AppDbContext>().UseSqlite(_connection).Options);
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _connection.Dispose();
    }

    // ---------- Saf seçici ----------

    private ProjectRevisionRetentionJob.AutoRevisionMeta Meta(
        Guid projectId, long revisionNumber, TimeSpan age) =>
        new(Guid.CreateVersion7(), projectId, revisionNumber, _now - age);

    /// <summary>Aynı saat kovasına düşen, hepsi eşiği aşmış yaşta N ardışık auto kaydı.</summary>
    private List<ProjectRevisionRetentionJob.AutoRevisionMeta> OldSameBucket(Guid projectId, int count)
    {
        // 3 gün önce, aynı saatin içinde saniye aralıklarla: hepsi TEK kovada.
        var baseAge = TimeSpan.FromDays(3);
        return Enumerable.Range(1, count)
            .Select(n => Meta(projectId, n, baseAge - TimeSpan.FromSeconds(n)))
            .ToList();
    }

    [Fact]
    public void ExactlyKeepCount_TouchesNothing()
    {
        var project = Guid.CreateVersion7();
        var autos = OldSameBucket(project, Defaults.KeepLatestAuto); // tam 50

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(autos, _now, Defaults);

        Assert.Empty(doomed);
    }

    [Fact]
    public void FiftyFirstOldRevision_SweepsExactlyTheOldest()
    {
        var project = Guid.CreateVersion7();
        var autos = OldSameBucket(project, Defaults.KeepLatestAuto + 1); // 51

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(autos, _now, Defaults);

        // En düşük revizyon numarası = en eski kayıt; kovası son-50'nin kayıtlarınca zaten
        // temsil edildiği için süpürülür.
        var oldest = autos.Single(r => r.RevisionNumber == 1);
        Assert.Equal([oldest.Id], doomed);
    }

    [Fact]
    public void YoungRevisionsBeyondKeepCount_AreSpared()
    {
        // Yoğun bir günün geçmişi aynı gün silinmez: 80 kayıt, hepsi son 24 saatin içinde.
        var project = Guid.CreateVersion7();
        var autos = Enumerable.Range(1, 80)
            .Select(n => Meta(project, n, TimeSpan.FromMinutes(n))) // en eskisi 80 dk
            .ToList();

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(autos, _now, Defaults);

        Assert.Empty(doomed);
    }

    [Fact]
    public void OldRevisionsInDistinctHourBuckets_AreKeptAsBucketRepresentatives()
    {
        // Son-50'nin dışında kalan eskiler FARKLI saat kovalarındaysa hepsi temsilci olarak
        // yaşar (inceltme "kova başına 1"dir, mutlak silme değil).
        var project = Guid.CreateVersion7();
        var young = Enumerable.Range(100, Defaults.KeepLatestAuto)
            .Select(n => Meta(project, n, TimeSpan.FromMinutes(160 - n))) // yüksek rev = genç
            .ToList();
        var oldDistinct = Enumerable.Range(1, 6)
            .Select(n => Meta(project, n, TimeSpan.FromDays(2) + TimeSpan.FromHours(7 - n)))
            .ToList();

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(
            [.. young, .. oldDistinct], _now, Defaults);

        Assert.Empty(doomed);
    }

    [Fact]
    public void OldRevisionsSharingABucket_ThinToTheNewestOfTheBucket()
    {
        var project = Guid.CreateVersion7();
        var young = Enumerable.Range(100, Defaults.KeepLatestAuto)
            .Select(n => Meta(project, n, TimeSpan.FromMinutes(160 - n))) // yüksek rev = genç
            .ToList();
        // 5 eski kayıt AYNI saatin içinde: en yenisi (rev 5) temsilci kalır, 4'ü silinir.
        var oldShared = OldSameBucket(project, 5);

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(
            [.. young, .. oldShared], _now, Defaults);

        var expected = oldShared.Where(r => r.RevisionNumber < 5).Select(r => r.Id).ToHashSet();
        Assert.Equal(expected, doomed.ToHashSet());
    }

    [Fact]
    public void OtherProjectsRevisions_AreNeverCounted()
    {
        // Proje izolasyonu: A'nın taşması B'nin (dolayısıyla başka kullanıcının) geçmişini
        // süpüremez — sayaçlar proje başınadır.
        var projectA = Guid.CreateVersion7();
        var projectB = Guid.CreateVersion7();
        var autos = OldSameBucket(projectA, Defaults.KeepLatestAuto + 1); // A: 51 → 1 silinir
        autos.AddRange(OldSameBucket(projectB, 10)); // B: 10 → dokunulmaz

        var doomed = ProjectRevisionRetentionJob.SelectAutoRevisionsToDelete(autos, _now, Defaults);

        var oldestOfA = autos.Single(r => r.ProjectId == projectA && r.RevisionNumber == 1);
        Assert.Equal([oldestOfA.Id], doomed);
    }

    // ---------- Gerçek DB koşumu (Sqlite in-memory) ----------

    private async Task<Guid> SeedProjectWithRevisionsAsync(
        int oldAutoCount, bool withCheckpoint, bool withPreRestore)
    {
        var project = new Project
        {
            Id = Guid.CreateVersion7(),
            OwnerId = Guid.CreateVersion7(),
            Name = "retention-test",
            Timeline = JsonDocument.Parse("{}"),
            RevisionNumber = 1000,
            CreatedAt = _now - TimeSpan.FromDays(30),
            UpdatedAt = _now,
        };
        _db.Projects.Add(project);

        var baseAge = TimeSpan.FromDays(3);
        for (var n = 1; n <= oldAutoCount; n++)
        {
            _db.ProjectRevisions.Add(ProjectRevision.Create(
                project.Id, n, JsonDocument.Parse("{}"), RevisionKind.Auto,
                project.OwnerId, _now - baseAge + TimeSpan.FromSeconds(n)));
        }

        if (withCheckpoint)
        {
            // Adlandırılmış nokta EN ESKİ kayıttan da eski: yaş/kova hiçbir koşulda silme
            // gerekçesi olamaz — tür koruması yaşa baskındır.
            _db.ProjectRevisions.Add(ProjectRevision.Create(
                project.Id, 990, JsonDocument.Parse("{}"), RevisionKind.Checkpoint,
                project.OwnerId, _now - TimeSpan.FromDays(20), label: "kullanıcının noktası"));
        }

        if (withPreRestore)
        {
            _db.ProjectRevisions.Add(ProjectRevision.Create(
                project.Id, 991, JsonDocument.Parse("{}"), RevisionKind.PreRestore,
                project.OwnerId, _now - TimeSpan.FromDays(20)));
        }

        await _db.SaveChangesAsync();
        return project.Id;
    }

    private ProjectRevisionRetentionJob Job(RevisionRetentionOptions? options = null) => new(
        _db, NullLogger<ProjectRevisionRetentionJob>.Instance,
        new FakeTimeProvider(_now), options ?? Defaults);

    private sealed class FakeTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Fact]
    public async Task Run_ThinsOnlyAutoRows_NamedCheckpointAndPreRestoreSurvive()
    {
        var projectId = await SeedProjectWithRevisionsAsync(
            oldAutoCount: 53, withCheckpoint: true, withPreRestore: true);

        await Job().Run(CancellationToken.None);

        var remaining = await _db.ProjectRevisions.AsNoTracking()
            .Where(r => r.ProjectId == projectId)
            .Select(r => new { r.Kind, r.RevisionNumber })
            .ToListAsync();
        // 53 eski auto aynı kovada: en yeni 50 kalır, 3'ü silinir; türler korunur.
        Assert.Equal(50, remaining.Count(r => r.Kind == RevisionKind.Auto));
        Assert.Single(remaining, r => r.Kind == RevisionKind.Checkpoint);
        Assert.Single(remaining, r => r.Kind == RevisionKind.PreRestore);
        // Silinenler EN ESKİ üç auto (1-3) — en yeniler duruyor.
        Assert.DoesNotContain(remaining, r => r.Kind == RevisionKind.Auto && r.RevisionNumber <= 3);
    }

    [Fact]
    public async Task Run_AtExactlyKeepCount_WritesNothing()
    {
        var projectId = await SeedProjectWithRevisionsAsync(
            oldAutoCount: 50, withCheckpoint: true, withPreRestore: false);

        await Job().Run(CancellationToken.None);

        Assert.Equal(51, await _db.ProjectRevisions.CountAsync(r => r.ProjectId == projectId));
    }

    [Fact]
    public async Task Run_InvalidOptions_RefusesLoudlyBeforeTouchingRows()
    {
        // Bozuk sabit (ör. env'de KeepLatestAuto=0) ilk koşumda geçmişi sessizce süpürmek
        // yerine tipli hatayla düşer (Program.cs açılış doğrulamasının koşum aynası).
        await SeedProjectWithRevisionsAsync(oldAutoCount: 10, withCheckpoint: false, withPreRestore: false);
        var broken = new RevisionRetentionOptions { KeepLatestAuto = 0 };

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => Job(broken).Run(CancellationToken.None));
        Assert.Equal(10, await _db.ProjectRevisions.CountAsync());
    }

    // ---------- Muhafız: recurring iş kaydı sökülmesin ----------

    [Fact]
    public void WorkerProgram_RegistersBothRecurringJobs()
    {
        var source = File.ReadAllText(
            TestVectorFiles.Resolve("backend/src/VideoEdit.Worker/Program.cs"));

        Assert.Matches(
            new Regex(@"AddOrUpdate<AssetReaperJob>\(\s*""asset-reaper""", RegexOptions.Singleline),
            source);
        Assert.Matches(
            new Regex(
                @"AddOrUpdate<ProjectRevisionRetentionJob>\(\s*""revision-retention""",
                RegexOptions.Singleline),
            source);
    }
}
