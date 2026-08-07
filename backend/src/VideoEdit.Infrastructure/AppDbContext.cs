using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using VideoEdit.Domain.Entities;

namespace VideoEdit.Infrastructure;

public class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectRevision> ProjectRevisions => Set<ProjectRevision>();
    public DbSet<Asset> Assets => Set<Asset>();
    public DbSet<ProjectAsset> ProjectAssets => Set<ProjectAsset>();
    public DbSet<Job> Jobs => Set<Job>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        // Npgsql JsonDocument'i jsonb'a natif map'ler; test provider'ları (Sqlite/InMemory)
        // için string'e çeviren converter kullanılır.
        var isNpgsql = Database.ProviderName?.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) == true;

        builder.Entity<AppUser>(e =>
        {
            e.Property(u => u.DisplayName).HasMaxLength(100);
            e.HasMany(u => u.RefreshTokens)
                .WithOne()
                .HasForeignKey(t => t.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<RefreshToken>(e =>
        {
            e.Property(t => t.TokenHash).HasMaxLength(64); // SHA-256 hex
            e.HasIndex(t => t.TokenHash).IsUnique();
            e.HasIndex(t => t.UserId);
        });

        builder.Entity<Project>(e =>
        {
            e.Property(p => p.Name).HasMaxLength(200);
            ConfigureJson(e.Property(p => p.Timeline), isNpgsql);
            // xmin yerine anlamlı, monoton sayaç — client'a dönen sürüm numarasıyla aynı.
            e.Property(p => p.RevisionNumber).IsConcurrencyToken();
            e.HasIndex(p => p.OwnerId);
        });

        builder.Entity<ProjectRevision>(e =>
        {
            ConfigureJson(e.Property(r => r.Timeline), isNpgsql);
            e.Property(r => r.Label).HasMaxLength(200);
            e.HasIndex(r => new { r.ProjectId, r.RevisionNumber }).IsUnique();
            e.HasOne<Project>()
                .WithMany()
                .HasForeignKey(r => r.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<Asset>(e =>
        {
            e.Property(a => a.OriginalFileName).HasMaxLength(500);
            e.Property(a => a.StorageKey).HasMaxLength(500);
            e.Property(a => a.ContentType).HasMaxLength(200);
            e.Property(a => a.ProxyKey).HasMaxLength(500);
            e.Property(a => a.FilmstripKey).HasMaxLength(500);
            e.Property(a => a.WaveformKey).HasMaxLength(500);
            e.Property(a => a.ThumbnailKey).HasMaxLength(500);
            ConfigureNullableJson(e.Property(a => a.Probe), isNpgsql);
            e.HasIndex(a => new { a.OwnerId, a.Status });
        });

        builder.Entity<ProjectAsset>(e =>
        {
            e.HasKey(pa => new { pa.ProjectId, pa.AssetId });
            e.HasOne<Project>()
                .WithMany()
                .HasForeignKey(pa => pa.ProjectId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Asset>()
                .WithMany()
                .HasForeignKey(pa => pa.AssetId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<Job>(e =>
        {
            ConfigureNullableJson(e.Property(j => j.TimelineSnapshot), isNpgsql);
            e.Property(j => j.ExportProfile).HasMaxLength(50);
            e.Property(j => j.ProgressStage).HasMaxLength(100);
            e.Property(j => j.OutputKey).HasMaxLength(500);
            e.Property(j => j.HangfireJobId).HasMaxLength(100);
            e.HasIndex(j => new { j.ProjectId, j.Status });
            e.HasIndex(j => new { j.AssetId, j.Status });
        });
    }

    private static void ConfigureJson(
        Microsoft.EntityFrameworkCore.Metadata.Builders.PropertyBuilder<JsonDocument> property, bool isNpgsql)
    {
        if (isNpgsql)
        {
            property.HasColumnType("jsonb");
        }
        else
        {
            property.HasConversion(JsonDocumentConverter, JsonDocumentComparer);
        }
    }

    private static void ConfigureNullableJson(
        Microsoft.EntityFrameworkCore.Metadata.Builders.PropertyBuilder<JsonDocument?> property, bool isNpgsql)
    {
        if (isNpgsql)
        {
            property.HasColumnType("jsonb");
        }
        else
        {
            property.HasConversion(NullableJsonDocumentConverter, NullableJsonDocumentComparer);
        }
    }

    private static readonly ValueConverter<JsonDocument, string> JsonDocumentConverter = new(
        d => d.RootElement.GetRawText(),
        s => JsonDocument.Parse(s, default(JsonDocumentOptions)));

    private static readonly ValueComparer<JsonDocument> JsonDocumentComparer = new(
        (a, b) => ReferenceEquals(a, b)
                  || (a != null && b != null && a.RootElement.GetRawText() == b.RootElement.GetRawText()),
        d => d.RootElement.GetRawText().GetHashCode(),
        d => JsonDocument.Parse(d.RootElement.GetRawText(), default(JsonDocumentOptions)));

    private static readonly ValueConverter<JsonDocument?, string?> NullableJsonDocumentConverter = new(
        d => d == null ? null : d.RootElement.GetRawText(),
        s => s == null ? null : JsonDocument.Parse(s, default(JsonDocumentOptions)));

    private static readonly ValueComparer<JsonDocument?> NullableJsonDocumentComparer = new(
        (a, b) => ReferenceEquals(a, b)
                  || (a != null && b != null && a.RootElement.GetRawText() == b.RootElement.GetRawText()),
        d => d == null ? 0 : d.RootElement.GetRawText().GetHashCode(),
        d => d == null ? null : JsonDocument.Parse(d.RootElement.GetRawText(), default(JsonDocumentOptions)));
}
