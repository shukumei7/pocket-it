using PocketIT.Service;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "PocketIT Agent";
});
builder.Services.AddHostedService<AgentWorker>();
builder.Build().Run();
