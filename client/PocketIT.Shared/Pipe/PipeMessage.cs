namespace PocketIT.Pipe;

public enum PipeMessageType
{
    // Service → Tray
    ChatMessage,
    DesktopStartRequest,
    DesktopMouseInput,
    DesktopKeyboardInput,
    DesktopStopRequest,
    DesktopQualityUpdate,
    DesktopSwitchMonitor,
    DesktopPasteText,
    DesktopCtrlAltDel,
    DesktopLaunchTool,
    DesktopFileUpload,
    DesktopToggle,
    ConsentRequired,
    AiStatusChanged,
    UpdateAvailable,
    ChatHistory,
    ServerUrlChanged,
    Connected,
    Disconnected,

    // Tray → Service
    ChatSend,
    DesktopStarted,
    DesktopDenied,
    DesktopStopped,
    DesktopFrame,
    DesktopPerfData,
    DesktopMonitors,
    DesktopFileUploadAck,
    ConsentGranted,
    ConsentDenied,
    SettingsUpdate,
    ScreenshotResult,

    // Elevated terminal (Tray → Service)
    ElevatedTerminalStart,  // payload: { "requestId": "..." }
    ElevatedTerminalInput,  // payload: { "input": "..." }
    ElevatedTerminalStop,   // payload: null

    // Elevated terminal (Service → Tray)
    ElevatedTerminalOutput, // payload: { "text": "..." }
    ElevatedTerminalEnded,  // payload: { "exitCode": 0 }
}

public class PipeMessage
{
    public PipeMessageType Type { get; set; }
    public string? RequestId { get; set; }
    public string? Payload { get; set; } // JSON-encoded payload
}
