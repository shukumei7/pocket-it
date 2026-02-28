using System;
using System.Threading;
using System.Windows.Forms;
using PocketIT.Core;

namespace PocketIT;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (s, e) => HandleCrash(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (s, e) =>
            HandleCrash(e.ExceptionObject as Exception ?? new Exception(e.ExceptionObject?.ToString()));

#if DEBUG
        const string MutexName = "PocketIT_Dev_SingleInstance";
#else
        const string MutexName = "PocketIT_SingleInstance";
#endif
        using var mutex = new Mutex(true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Pocket IT is already running.", "Pocket IT", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        string? enrollToken = null;
        var args = Environment.GetCommandLineArgs();
        for (int i = 1; i < args.Length - 1; i++)
        {
            if (args[i] == "--enroll-token")
            {
                enrollToken = args[i + 1];
                break;
            }
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplication(enrollToken));
    }

    private static void HandleCrash(Exception ex)
    {
        try { Logger.Error("Unhandled exception — Task Scheduler will restart the app", ex); } catch { }
        Environment.Exit(1); // Non-zero exit triggers Task Scheduler RestartOnFailure
    }
}
