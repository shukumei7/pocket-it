using System;
using System.Collections.Generic;
using Microsoft.Data.Sqlite;

namespace PocketIT.Core;

public class LocalDatabase : IDisposable
{
    private readonly SqliteConnection _connection;

    public LocalDatabase(string dbPath)
    {
        _connection = new SqliteConnection($"Data Source={dbPath}");
        _connection.Open();
        InitSchema();
    }

    private void InitSchema()
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS offline_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                synced INTEGER DEFAULT 0
            )";
        cmd.ExecuteNonQuery();
    }

    public void SaveMessage(string content)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "INSERT INTO offline_messages (content) VALUES (@content)";
        cmd.Parameters.AddWithValue("@content", content);
        cmd.ExecuteNonQuery();
    }

    public List<(long Id, string Content)> GetUnsyncedMessages()
    {
        var messages = new List<(long, string)>();
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "SELECT id, content FROM offline_messages WHERE synced = 0 ORDER BY id";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            messages.Add((reader.GetInt64(0), reader.GetString(1)));
        }
        return messages;
    }

    public void MarkSynced(long id)
    {
        using var cmd = _connection.CreateCommand();
        cmd.CommandText = "UPDATE offline_messages SET synced = 1 WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        _connection.Dispose();
    }
}
