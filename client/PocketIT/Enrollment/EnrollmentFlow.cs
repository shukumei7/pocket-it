using System.Net.Http;
using System.Text;
using System.Text.Json;
using PocketIT.Core;

namespace PocketIT.Enrollment;

public class EnrollmentResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string DeviceSecret { get; set; } = "";
}

public class EnrollmentFlow
{
    private readonly string _serverUrl;
    private readonly HttpClient _http;

    public EnrollmentFlow(string serverUrl)
    {
        _serverUrl = serverUrl.TrimEnd('/');
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    }

    public async Task<EnrollmentResult> EnrollAsync(string token)
    {
        var deviceId = DeviceIdentity.GetMachineId();
        var hostname = DeviceIdentity.GetHostname();
        var osVersion = DeviceIdentity.GetOsVersion();

        var payload = new
        {
            token,
            deviceId,
            hostname,
            osVersion
        };

        try
        {
            var json = JsonSerializer.Serialize(payload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");
            var response = await _http.PostAsync($"{_serverUrl}/api/enrollment/enroll", content);
            var responseBody = await response.Content.ReadAsStringAsync();

            if (response.IsSuccessStatusCode)
            {
                var responseDoc = JsonDocument.Parse(responseBody);
                var deviceSecret = "";
                if (responseDoc.RootElement.TryGetProperty("deviceSecret", out var secretProp))
                {
                    deviceSecret = secretProp.GetString() ?? "";
                }
                return new EnrollmentResult
                {
                    Success = true,
                    Message = "Device enrolled successfully!",
                    DeviceId = deviceId,
                    DeviceSecret = deviceSecret
                };
            }
            else
            {
                var errorDoc = JsonDocument.Parse(responseBody);
                var errorMsg = errorDoc.RootElement.TryGetProperty("error", out var err)
                    ? err.GetString() ?? "Unknown error"
                    : "Enrollment failed";
                return new EnrollmentResult
                {
                    Success = false,
                    Message = errorMsg
                };
            }
        }
        catch (Exception ex)
        {
            return new EnrollmentResult
            {
                Success = false,
                Message = $"Connection error: {ex.Message}"
            };
        }
    }

    public async Task<bool> CheckEnrolledAsync()
    {
        var deviceId = DeviceIdentity.GetMachineId();
        try
        {
            var response = await _http.GetAsync($"{_serverUrl}/api/devices/{deviceId}");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }
}
