using Microsoft.Win32;
using System;
using System.Diagnostics;

namespace PocketIT.Core
{
    public static class StartupManager
    {
        private const string TaskName = "PocketIT";
        private const string RegistryKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

        public static bool IsRegistered()
        {
            try
            {
                var result = RunSchtasks($"/Query /TN \"{TaskName}\"");
                return result.ExitCode == 0;
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to query startup task", ex);
                return false;
            }
        }

        public static void Register()
        {
            try
            {
                var exePath = Environment.ProcessPath ?? System.Reflection.Assembly.GetExecutingAssembly().Location;
                var result = RunSchtasks($"/Create /TN \"{TaskName}\" /TR \"\\\"{exePath}\\\"\" /SC ONLOGON /RL HIGHEST /F");
                if (result.ExitCode == 0)
                {
                    Logger.Info($"Registered for Windows startup via Task Scheduler: {exePath}");
                }
                else
                {
                    Logger.Error($"Failed to register startup task (exit {result.ExitCode}): {result.StdErr}");
                }

                // One-time migration: clean up old registry Run key if present
                try
                {
                    using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath, true);
                    if (key?.GetValue(TaskName) != null)
                    {
                        key.DeleteValue(TaskName);
                        Logger.Info("Removed legacy registry Run key (migration)");
                    }
                }
                catch (Exception regEx)
                {
                    Logger.Error("Failed to clean up legacy registry Run key", regEx);
                }
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to register for Windows startup", ex);
            }
        }

        public static void Unregister()
        {
            try
            {
                var result = RunSchtasks($"/Delete /TN \"{TaskName}\" /F");
                if (result.ExitCode == 0)
                {
                    Logger.Info("Unregistered from Windows startup");
                }
                else
                {
                    Logger.Error($"Failed to delete startup task (exit {result.ExitCode}): {result.StdErr}");
                }
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to unregister from Windows startup", ex);
            }
        }

        public static void Toggle()
        {
            if (IsRegistered())
                Unregister();
            else
                Register();
        }

        private static (int ExitCode, string StdOut, string StdErr) RunSchtasks(string arguments)
        {
            var psi = new ProcessStartInfo("schtasks", arguments)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var process = Process.Start(psi)!;
            var stdOut = process.StandardOutput.ReadToEnd();
            var stdErr = process.StandardError.ReadToEnd();
            process.WaitForExit();

            return (process.ExitCode, stdOut, stdErr);
        }
    }
}
