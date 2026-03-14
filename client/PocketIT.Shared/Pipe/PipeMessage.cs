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
}

public class PipeMessage
{
    public PipeMessageType Type { get; set; }
    public string? RequestId { get; set; }
    public string? Payload { get; set; } // JSON-encoded payload
}
