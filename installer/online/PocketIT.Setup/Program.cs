using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PocketIT.Setup;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
    }
}

public class SetupForm : Form
{
    private readonly Label _statusLabel;
    private readonly ProgressBar _progressBar;
    private readonly Button _cancelBtn;
    private EmbeddedConfig? _config;

    public SetupForm()
    {
        Text = "Pocket IT Setup";
        Width = 440;
        Height = 190;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;

        _statusLabel = new Label { Text = "Preparing installation...", Left = 20, Top = 20, Width = 390, Height = 20 };
        _progressBar = new ProgressBar { Left = 20, Top = 50, Width = 390, Height = 25, Style = ProgressBarStyle.Marquee };
        _cancelBtn = new Button { Text = "Cancel", Left = 330, Top = 100, Width = 80, Height = 30 };
        _cancelBtn.Click += (_, _) => { Application.Exit(); };

        Controls.AddRange(new Control[] { _statusLabel, _progressBar, _cancelBtn });

        Load += async (_, _) => await RunInstallAsync();
    }

    private async Task RunInstallAsync()
    {
        try
        {
            // Read embedded config
            try
            {
                _config = EmbeddedConfig.Read();
            }
            catch (Exception ex)
            {
                MessageBox.Show($"This installer has no embedded configuration.\n\n{ex.Message}",
                    "Configuration Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Application.Exit();
                return;
            }

            var installPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PocketIT");

            // Step 1: Download client package
            UpdateStatus("Downloading Pocket IT...");
            var zipPath = Path.Combine(Path.GetTempPath(), "PocketIT-package.zip");

            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            var downloadUrl = $"{_config.ServerUrl.TrimEnd('/')}/api/installer/package?token={_config.EnrollmentToken}";

            using var response = await http.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead);
            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync();
                throw new Exception($"Download failed (HTTP {(int)response.StatusCode}): {errorBody}");
            }

            var totalBytes = response.Content.Headers.ContentLength ?? -1;
            if (totalBytes > 0)
            {
                _progressBar.Style = ProgressBarStyle.Continuous;
                _progressBar.Maximum = 100;
            }

            await using (var contentStream = await response.Content.ReadAsStreamAsync())
            await using (var fileStream = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                long downloaded = 0;
                int bytesRead;
                while ((bytesRead = await contentStream.ReadAsync(buffer)) > 0)
                {
                    await fileStream.WriteAsync(buffer.AsMemory(0, bytesRead));
                    downloaded += bytesRead;
                    if (totalBytes > 0)
                        _progressBar.Value = (int)(downloaded * 100 / totalBytes);
                }
            }

            // Step 2: Stop existing PocketIT if running
            UpdateStatus("Stopping existing Pocket IT...");
            foreach (var proc in Process.GetProcessesByName("PocketIT"))
            {
                try { proc.Kill(); proc.WaitForExit(5000); } catch { }
            }

            // Step 3: Extract files
            UpdateStatus("Installing files...");
            string? preservedConfigPath = null;
            string? preservedDbPath = null;

            if (Directory.Exists(installPath))
            {
                // Preserve existing config and database
                var existingConfig = Path.Combine(installPath, "appsettings.json");
                var existingDb = Path.Combine(installPath, "pocket-it.db");

                if (File.Exists(existingConfig))
                {
                    preservedConfigPath = existingConfig + ".setup-bak";
                    // Remove read-only if set (tamper protection)
                    var attrs = File.GetAttributes(existingConfig);
                    if (attrs.HasFlag(FileAttributes.ReadOnly))
                        File.SetAttributes(existingConfig, attrs & ~FileAttributes.ReadOnly);
                    File.Copy(existingConfig, preservedConfigPath, true);
                }
                if (File.Exists(existingDb))
                {
                    preservedDbPath = existingDb + ".setup-bak";
                    File.Copy(existingDb, preservedDbPath, true);
                }

                Directory.Delete(installPath, true);
            }

            Directory.CreateDirectory(installPath);
            ZipFile.ExtractToDirectory(zipPath, installPath);

            // Restore preserved files (upgrade scenario)
            if (preservedConfigPath != null && File.Exists(preservedConfigPath))
            {
                File.Copy(preservedConfigPath, Path.Combine(installPath, "appsettings.json"), true);
                File.Delete(preservedConfigPath);
            }
            if (preservedDbPath != null && File.Exists(preservedDbPath))
            {
                File.Copy(preservedDbPath, Path.Combine(installPath, "pocket-it.db"), true);
                File.Delete(preservedDbPath);
            }

            // Step 4: Write appsettings.json (fresh install only)
            var appsettingsPath = Path.Combine(installPath, "appsettings.json");
            if (!File.Exists(appsettingsPath))
            {
                UpdateStatus("Writing configuration...");
                var settings = new
                {
                    Server = new { Url = _config.ServerUrl, ReconnectInterval = 5000 },
                    Enrollment = new { Token = _config.EnrollmentToken },
                    Database = new { Path = "pocket-it.db" },
                    Monitoring = new { IntervalMinutes = 15 }
                };
                File.WriteAllText(appsettingsPath,
                    JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
            }

            // Step 5: Set folder permissions
            UpdateStatus("Setting permissions...");
            RunCmd("icacls",
                $"\"{installPath}\" /inheritance:r /grant:r \"SYSTEM:(OI)(CI)F\" \"BUILTIN\\Administrators:(OI)(CI)F\" \"BUILTIN\\Users:(OI)(CI)RX\"");

            // Step 6: Protect config file
            File.SetAttributes(appsettingsPath, File.GetAttributes(appsettingsPath) | FileAttributes.ReadOnly);

            // Step 7: Register auto-start via Task Scheduler
            UpdateStatus("Registering auto-start...");
            var exePath = Path.Combine(installPath, "PocketIT.exe");
            RunCmd("schtasks",
                $"/Create /TN \"PocketIT\" /TR \"\\\"{exePath}\\\"\" /SC ONLOGON /RL HIGHEST /F");

            // Step 8: Clean up temp file
            try { File.Delete(zipPath); } catch { }

            // Step 9: Launch
            UpdateStatus("Launching Pocket IT...");
            Process.Start(new ProcessStartInfo(exePath) { UseShellExecute = true });

            _cancelBtn.Text = "Close";
            UpdateStatus("Installation complete!");
            _progressBar.Style = ProgressBarStyle.Continuous;
            _progressBar.Value = 100;

            MessageBox.Show("Pocket IT has been installed successfully!\n\nThe application is now running in the system tray.",
                "Setup Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Application.Exit();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Installation failed:\n\n{ex.Message}", "Setup Error",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            _cancelBtn.Text = "Close";
            UpdateStatus("Installation failed.");
        }
    }

    private void UpdateStatus(string text)
    {
        if (InvokeRequired)
            Invoke(() => _statusLabel.Text = text);
        else
            _statusLabel.Text = text;
    }

    private static void RunCmd(string fileName, string arguments)
    {
        using var process = Process.Start(new ProcessStartInfo(fileName, arguments)
        {
            CreateNoWindow = true,
            UseShellExecute = false
        });
        process?.WaitForExit(15000);
    }
}
