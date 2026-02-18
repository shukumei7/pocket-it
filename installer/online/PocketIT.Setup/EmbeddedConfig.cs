using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace PocketIT.Setup;

public class EmbeddedConfig
{
    public string ServerUrl { get; set; } = "";
    public string EnrollmentToken { get; set; } = "";

    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("PKIT_CFG");

    /// <summary>
    /// Reads the embedded configuration from the end of the currently running EXE.
    /// </summary>
    public static EmbeddedConfig Read()
    {
        var exePath = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exePath))
            throw new InvalidOperationException("Cannot determine executable path.");

        using var stream = File.OpenRead(exePath);

        if (stream.Length < Magic.Length + 4)
            throw new InvalidOperationException("No embedded configuration found.");

        // Read magic marker from end
        stream.Seek(-Magic.Length, SeekOrigin.End);
        var marker = new byte[Magic.Length];
        stream.ReadExactly(marker, 0, marker.Length);

        for (int i = 0; i < Magic.Length; i++)
        {
            if (marker[i] != Magic[i])
                throw new InvalidOperationException("No embedded configuration found. This installer may be corrupted.");
        }

        // Read JSON length (4 bytes before magic)
        stream.Seek(-Magic.Length - 4, SeekOrigin.End);
        var lengthBytes = new byte[4];
        stream.ReadExactly(lengthBytes, 0, 4);
        var jsonLength = BitConverter.ToInt32(lengthBytes, 0);

        if (jsonLength <= 0 || jsonLength > 10000)
            throw new InvalidOperationException("Invalid embedded configuration data.");

        // Read JSON
        stream.Seek(-Magic.Length - 4 - jsonLength, SeekOrigin.End);
        var jsonBytes = new byte[jsonLength];
        stream.ReadExactly(jsonBytes, 0, jsonLength);

        var json = Encoding.UTF8.GetString(jsonBytes);
        return JsonSerializer.Deserialize<EmbeddedConfig>(json)
            ?? throw new InvalidOperationException("Failed to parse embedded configuration.");
    }
}
