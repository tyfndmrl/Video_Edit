using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace VideoEdit.Infrastructure.Migrations
{
    /// <inheritdoc />
    public partial class AddJobHeartbeat : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "LastProgressAt",
                table: "Jobs",
                type: "timestamp with time zone",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "LastProgressAt",
                table: "Jobs");
        }
    }
}
