using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VideoEdit.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddAssetDerivedBytes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<long>(
                name: "DerivedBytes",
                table: "Assets",
                type: "bigint",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DerivedBytes",
                table: "Assets");
        }
    }
}
