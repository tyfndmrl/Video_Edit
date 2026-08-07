using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VideoEdit.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddAssetUploadInfra : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "HangfireJobId",
                table: "Jobs",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "ProcessingStartedAt",
                table: "Assets",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "HangfireJobId",
                table: "Jobs");

            migrationBuilder.DropColumn(
                name: "ProcessingStartedAt",
                table: "Assets");
        }
    }
}
