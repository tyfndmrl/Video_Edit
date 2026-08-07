using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace VideoEdit.Infrastructure;

/// <summary>
/// dotnet-ef migration üretimi için design-time factory — DB ayakta olmadan çalışır
/// (yalnız model'e bakar; bağlantı string'i migration üretiminde kullanılmaz).
/// </summary>
public class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql("Host=localhost;Port=5432;Database=videoedit;Username=app;Password=devpassword")
            .Options;
        return new AppDbContext(options);
    }
}
