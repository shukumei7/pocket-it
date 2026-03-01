using Microsoft.Win32;
using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;

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
                var currentUser = WindowsIdentity.GetCurrent().Name;

                // XML-escape the exe path (handles & in paths)
                var escapedExe = exePath.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");

                // Task XML with RestartOnFailure — schtasks /Create CLI cannot set this, XML import can.
                // RestartOnFailure: restart up to 999 times with 1-minute intervals after any crash/non-zero exit.
                // No hourly TimeTrigger: Register() is called with /F on every startup which resets Task Scheduler's
                // instance tracking, causing IgnoreNew to stop working and triggering spurious hourly launches.
                // RestartOnFailure (999x, 1min) is sufficient — hourly watchdog was redundant and caused problems.
                var xml = $@"<?xml version=""1.0"" encoding=""UTF-16""?>
<Task version=""1.4"" xmlns=""http://schemas.microsoft.com/windows/2004/02/mit/task"">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{currentUser}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id=""Author"">
      <UserId>{currentUser}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context=""Author"">
    <Exec>
      <Command>{escapedExe}</Command>
    </Exec>
  </Actions>
</Task>";

                var tempFile = Path.Combine(Path.GetTempPath(), "PocketIT-task.xml");
                File.WriteAllText(tempFile, xml, Encoding.Unicode);
                try
                {
                    var result = RunSchtasks($"/Create /TN \"{TaskName}\" /XML \"{tempFile}\" /F");
                    if (result.ExitCode == 0)
                        Logger.Info($"Registered for Windows startup with crash recovery: {exePath}");
                    else
                        Logger.Error($"Failed to register startup task (exit {result.ExitCode}): {result.StdErr}");
                }
                finally
                {
                    try { File.Delete(tempFile); } catch { }
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
