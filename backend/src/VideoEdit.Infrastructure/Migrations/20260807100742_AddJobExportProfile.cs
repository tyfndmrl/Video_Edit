using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VideoEdit.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddJobExportProfile : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ExportProfile",
                table: "Jobs",
                type: "character varying(50)",
                maxLength: 50,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ExportProfile",
                table: "Jobs");
        }
    }
}
