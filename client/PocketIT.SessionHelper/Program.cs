using PocketIT.SessionHelper;
using PocketIT.SessionHelper.Pipe;

// IT authority: service-level access bypasses user privacy mode.
// This helper is spawned by PocketIT.Service into the active user session
// via WTSQueryUserToken + CreateProcessAsUser. No consent check is performed
// here because service-level remote desktop is IT authority on enrolled managed devices.

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: PocketIT.SessionHelper.exe <pipe-name>");
    return 1;
}

string pipeName = args[0];

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

// Also exit cleanly if the pipe dies (service stopped)
AppDomain.CurrentDomain.UnhandledException += (_, _) => cts.Cancel();

using var pipeClient = new DesktopPipeClient(pipeName);

try
{
    await pipeClient.ConnectAsync(cts.Token);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Failed to connect to desktop pipe '{pipeName}': {ex.Message}");
    return 2;
}

using var session = new DesktopSession(pipeClient);
session.Start();

// Signal the service that we are ready
await pipeClient.SendEventAsync("ready", cts.Token);

// Block reading pipe messages until stopped or disconnected
try
{
    await pipeClient.ReadLoopAsync(cts.Token);
}
catch (OperationCanceledException) { }
catch (Exception ex)
{
    Console.Error.WriteLine($"Pipe read error: {ex.Message}");
}

session.Stop();
return 0;
