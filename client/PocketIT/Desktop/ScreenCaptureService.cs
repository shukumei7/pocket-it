using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace PocketIT.Desktop;

public record MonitorInfo(int Index, string Name, int Width, int Height, bool Primary);

public class ScreenCaptureService
{
    private readonly object _lock = new();
    private int _quality = 50;
    private float _scale = 0.5f;
    private int _currentMonitorIndex = 0;

    public int Quality { get => _quality; set => _quality = Math.Clamp(value, 10, 100); }
    public float Scale { get => _scale; set => _scale = Math.Clamp(value, 0.25f, 1.0f); }
    public int CurrentMonitorIndex => _currentMonitorIndex;

    public Rectangle GetCurrentMonitorBounds()
    {
        var screens = System.Windows.Forms.Screen.AllScreens;
        if (_currentMonitorIndex >= 0 && _currentMonitorIndex < screens.Length)
            return screens[_currentMonitorIndex].Bounds;
        return System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
    }

    public List<MonitorInfo> GetMonitors()
    {
        var screens = System.Windows.Forms.Screen.AllScreens;
        var result = new List<MonitorInfo>(screens.Length);
        for (int i = 0; i < screens.Length; i++)
        {
            var s = screens[i];
            result.Add(new MonitorInfo(i, s.DeviceName, s.Bounds.Width, s.Bounds.Height, s.Primary));
        }
        return result;
    }

    public void SetMonitor(int index)
    {
        var screens = System.Windows.Forms.Screen.AllScreens;
        if (index < 0 || index >= screens.Length)
            throw new ArgumentOutOfRangeException(nameof(index), $"Monitor index {index} is out of range. Available monitors: 0-{screens.Length - 1}.");
        _currentMonitorIndex = index;
    }

    public (string base64, int width, int height) CaptureScreen()
    {
        lock (_lock)
        {
            var bounds = GetCurrentMonitorBounds();
            using var bitmap = new Bitmap(bounds.Width, bounds.Height);
            using (var g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            }

            // Scale down
            int targetW = (int)(bounds.Width * _scale);
            int targetH = (int)(bounds.Height * _scale);
            using var scaled = new Bitmap(targetW, targetH);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                g.DrawImage(bitmap, 0, 0, targetW, targetH);
            }

            // Encode as JPEG
            using var ms = new MemoryStream();
            var encoder = ImageCodecInfo.GetImageDecoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            var encoderParams = new EncoderParameters(1);
            encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)_quality);
            scaled.Save(ms, encoder, encoderParams);
            return (Convert.ToBase64String(ms.ToArray()), targetW, targetH);
        }
    }
}
