using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace PocketIT.Desktop;

public class ScreenCaptureService
{
    private readonly object _lock = new();
    private int _quality = 50;
    private float _scale = 0.5f;

    public int Quality { get => _quality; set => _quality = Math.Clamp(value, 10, 100); }
    public float Scale { get => _scale; set => _scale = Math.Clamp(value, 0.25f, 1.0f); }

    public (string base64, int width, int height) CaptureScreen()
    {
        lock (_lock)
        {
            var bounds = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
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
