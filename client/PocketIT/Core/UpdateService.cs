using System;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace PocketIT.Core;

public class UpdateInfo
{
    public bool UpdateAvailable { get; set; }
    public string LatestVersion { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long FileSize { get; set; }
    public string? ReleaseNotes { get; set; }
}

public class UpdateService : IDisposable
{
    private readonly string _serverUrl;
    private readonly string _deviceId;
    private readonly string _deviceSecret;
    private readonly HttpClient _httpClient;
    private readonly System.Timers.Timer _checkTimer;
    private bool _isUpdating;

    public event Action<UpdateInfo>? OnUpdateAvailable;

    public UpdateService(string serverUrl, string deviceId, string deviceSecret)
    {
        _serverUrl = serverUrl.TrimEnd('/');
        _deviceId = deviceId;
        _deviceSecret = deviceSecret;
        _httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _httpClient.DefaultRequestHeaders.Add("X-Device-Id", _deviceId);
        _httpClient.DefaultRequestHeaders.Add("X-Device-Secret", _deviceSecret);

        // Check every 4 hours
        _checkTimer = new System.Timers.Timer(4 * 60 * 60 * 1000);
        _checkTimer.Elapsed += async (_, _) => await CheckForUpdateAsync();
    }

    public void Start()
    {
        _checkTimer.Start();
        // Check on startup (delayed 30 seconds to let connection stabilize)
        _ = Task.Run(async () =>
        {
            await Task.Delay(30000);
            await CheckForUpdateAsync();
        });
    }

    public async Task<UpdateInfo?> CheckForUpdateAsync()
    {
        if (_isUpdating) return null;

        try
        {
            var url = $"{_serverUrl}/api/updates/check?version={AppVersion.Current}";
            var response = await _httpClient.GetAsync(url);

            if (!response.IsSuccessStatusCode)
            {
                Logger.Warn($"Update check failed: HTTP {(int)response.StatusCode}");
                return null;
            }

            var json = await response.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var updateAvailable = root.TryGetProperty("updateAvailable", out var uaProp) && uaProp.GetBoolean();
            if (!updateAvailable) return new UpdateInfo { UpdateAvailable = false };

            var info = new UpdateInfo
            {
                UpdateAvailable = true,
                LatestVersion = root.GetProperty("latestVersion").GetString() ?? "",
                DownloadUrl = root.GetProperty("downloadUrl").GetString() ?? "",
                Sha256 = root.GetProperty("sha256").GetString() ?? "",
                FileSize = root.GetProperty("fileSize").GetInt64(),
                ReleaseNotes = root.TryGetProperty("releaseNotes", out var rnProp) ? rnProp.GetString() : null
            };

            Logger.Info($"Update available: {AppVersion.Current} -> {info.LatestVersion}");
            OnUpdateAvailable?.Invoke(info);
            return info;
        }
        catch (Exception ex)
        {
            Logger.Warn($"Update check error: {ex.Message}");
            return null;
        }
    }

    public async Task<bool> DownloadAndApplyAsync(UpdateInfo info)
    {
        if (_isUpdating) return false;
        _isUpdating = true;

        try
        {
            Logger.Info($"Downloading update {info.LatestVersion}...");

            // Download to temp directory
            var tempDir = Path.Combine(Path.GetTempPath(), "PocketIT-Update");
            Directory.CreateDirectory(tempDir);
            var installerPath = Path.Combine(tempDir, $"PocketIT-{info.LatestVersion}-setup.exe");

            // Download the installer
            var url = $"{_serverUrl}{info.DownloadUrl}";
            using var response = await _httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode();

            using (var stream = await response.Content.ReadAsStreamAsync())
            using (var fileStream = new FileStream(installerPath, FileMode.Create, System.IO.FileAccess.Write, FileShare.None))
            {
                await stream.CopyToAsync(fileStream);
            }

            Logger.Info($"Download complete: {installerPath}");

            // Verify SHA-256
            var actualHash = ComputeSha256(installerPath);
            if (!string.Equals(actualHash, info.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                Logger.Error($"SHA-256 mismatch! Expected: {info.Sha256}, Got: {actualHash}");
                try { File.Delete(installerPath); } catch { }
                _isUpdating = false;
                return false;
            }

            Logger.Info("SHA-256 verified. Launching installer...");

            // Launch the installer in silent mode
            var process = new System.Diagnostics.Process
            {
                StartInfo = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = installerPath,
                    Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS",
                    UseShellExecute = true
                }
            };
            process.Start();

            // The installer will kill this process, replace files, and relaunch
            // Give it a moment to start, then exit gracefully
            await Task.Delay(2000);
            Environment.Exit(0);

            return true; // Won't reach here
        }
        catch (Exception ex)
        {
            Logger.Error($"Update failed: {ex.Message}", ex);
            _isUpdating = false;
            return false;
        }
    }

    private static string ComputeSha256(string filePath)
    {
        using var sha256 = SHA256.Create();
        using var stream = File.OpenRead(filePath);
        var hash = sha256.ComputeHash(stream);
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    }

    public void Dispose()
    {
        _checkTimer.Dispose();
        _httpClient.Dispose();
    }
}
