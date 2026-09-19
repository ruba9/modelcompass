using Azure.Core;
using Azure.Identity;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod()));
builder.Services.AddHttpClient();

var app = builder.Build();
app.UseCors();

var catalog = ModelCatalog.All;

app.MapGet("/api/health", () => Results.Ok(new { status = "ready", catalogUpdatedAt = ModelCatalog.UpdatedAt }));

app.MapGet("/api/models", (string? modality, string? region, bool? openSource) =>
{
    var models = catalog.AsEnumerable();
    if (!string.IsNullOrWhiteSpace(modality))
        models = models.Where(model => model.Modalities.Contains(modality, StringComparer.OrdinalIgnoreCase));
    if (!string.IsNullOrWhiteSpace(region))
        models = models.Where(model => model.Regions.Contains(region, StringComparer.OrdinalIgnoreCase));
    if (openSource is not null)
        models = models.Where(model => model.OpenSource == openSource);

    return Results.Ok(new CatalogResponse(ModelCatalog.UpdatedAt, models.ToArray(), ModelCatalog.Sources));
});

app.MapPost("/api/recommendations", (ProjectProfile profile) =>
{
    var eligible = catalog
        .Where(model => profile.Modalities.All(required => model.Modalities.Contains(required, StringComparer.OrdinalIgnoreCase)))
        .Where(model => model.ContextWindow >= profile.MinimumContext)
        .Where(model => MeetsLatencyRequirement(model, profile.LatencyRequirement))
        .Where(model => MeetsQualityBar(model, profile.QualityBar))
        .Where(model => !profile.OpenSourceOnly || model.OpenSource)
        .Where(model => !profile.ExcludeAgreementRequired || !model.Legal.RequiresAgreement)
        .Where(model => !profile.RequireSelfHosting || model.SelfHostable)
        .Where(model => !profile.RequireStructuredJson || model.Operations.Output.StructuredJson)
        .Where(model => !profile.RequireToolCalling || model.Evidence.ToolUse.Supported)
        .Where(model => !profile.RequireStreaming || model.Operations.Output.Streaming)
        .Where(model => !profile.RequireFineTuning || model.Operations.Compute.FineTuningSupported)
        .Where(model => MeetsComputePreference(model, profile.ComputePreference))
        .Where(model => !profile.RequireDataResidency || model.Regions.Contains(profile.Region, StringComparer.OrdinalIgnoreCase))
        .Where(model => profile.MaxInputCostPerMillion is null || model.InputCostPerMillion <= profile.MaxInputCostPerMillion)
        .Where(model => profile.MonthlyBudgetUsd is null || EstimateMonthlyCost(model, profile) <= profile.MonthlyBudgetUsd)
        .Select(model => Score(model, profile))
        .OrderByDescending(result => result.Score)
        .ToArray();
    var candidates = eligible.Take(4).ToArray();

    return Results.Ok(new RecommendationResponse(candidates, BuildCostOptimizations(eligible, profile), BuildFoundryModelRouterRecommendation(profile), candidates.Length == 0
        ? "No model meets every hard constraint. Increase the budget, reduce context, or allow another deployment option."
        : null));
});

static bool MeetsLatencyRequirement(ModelCard model, string? requirement) => requirement?.ToLowerInvariant() switch
{
    "real-time" => model.SpeedScore >= 85,
    "interactive" => model.SpeedScore >= 70,
    _ => true
};

static bool MeetsQualityBar(ModelCard model, string? qualityBar) => qualityBar?.ToLowerInvariant() switch
{
    "frontier" => model.QualityScore >= 92,
    "high" => model.QualityScore >= 84,
    _ => true
};

static bool MeetsComputePreference(ModelCard model, string? preference) => preference?.ToLowerInvariant() switch
{
    "managed" => model.Operations.Compute.ManagedCompute,
    "self-hosted-gpu" => model.Operations.Compute.SelfHostedGpu,
    _ => true
};

static decimal EstimateMonthlyCost(ModelCard model, ProjectProfile profile)
{
    var monthlyCalls = Math.Max(0, profile.CallsPerDay) * 30m;
    var inputCost = Math.Max(0, profile.AverageInputTokens) / 1_000_000m * model.InputCostPerMillion;
    var outputCost = Math.Max(0, profile.AverageOutputTokens) / 1_000_000m * model.OutputCostPerMillion;
    return monthlyCalls * (inputCost + outputCost);
}

static CostOptimization[] BuildCostOptimizations(Recommendation[] eligible, ProjectProfile profile)
{
    if (eligible.Length == 0) return [];
    var preferred = eligible[0].Model;
    var preferredCost = EstimateMonthlyCost(preferred, profile);
    var economy = eligible.OrderBy(item => EstimateMonthlyCost(item.Model, profile)).First().Model;
    var economyCost = EstimateMonthlyCost(economy, profile);
    var outputSavings = Math.Max(0, profile.CallsPerDay) * 30m * Math.Max(0, profile.AverageOutputTokens) * 0.2m / 1_000_000m * preferred.OutputCostPerMillion;
    var advice = new List<CostOptimization>();
    if (economy.Id != preferred.Id)
        advice.Add(new("Route routine traffic to the economy model", $"Use {economy.Name} for low-risk requests and keep {preferred.Name} for complex work.", Math.Round(preferredCost - economyCost, 2), economy.Id));
    else
        advice.Add(new("Current leader is already the lowest-cost eligible model", $"{preferred.Name} leads the weighted score and projected token cost for this profile.", 0, preferred.Id));
    if (outputSavings > 0)
        advice.Add(new("Cap routine response length", "Reducing average output tokens by 20% lowers spend without changing the selected provider. Validate answer completeness before rollout.", Math.Round(outputSavings, 2), preferred.Id));
    if (profile.CallsPerDay >= 1000 && eligible.Length > 1)
        advice.Add(new("Use policy routing instead of one model for every request", "Send simple, latency-sensitive, and complex requests to separate eligible models, then monitor fallback and quality rates.", Math.Round(Math.Max(0, preferredCost - economyCost) * 0.7m, 2), economy.Id));
    return advice.ToArray();
}

static FoundryModelRouterRecommendation BuildFoundryModelRouterRecommendation(ProjectProfile profile)
{
    var routingMode = profile.CostWeight > profile.QualityWeight
        ? "Cost"
        : profile.QualityWeight > profile.CostWeight * 2
            ? "Quality"
            : "Balanced";
    return new(
        "model-router",
        "2025-11-18",
        routingMode,
        "A single Microsoft Foundry deployment that selects an eligible underlying model for each request. It is separate from the ranked direct-model shortlist.",
        [
            "One endpoint and deployment for a diverse prompt mix",
            "Managed per-request cost and quality optimization",
            "Built-in automatic failover and serving-model visibility",
            "Optional model subset for compliance and performance control"
        ],
        [
            "Deploy in a supported Microsoft Foundry region and SKU",
            "Use the full supported pool or explicitly configure a model subset",
            "Deploy Claude models separately before including them in the routing subset",
            "Evaluate router quality, latency, and cost against a direct-model baseline"
        ],
        "https://learn.microsoft.com/azure/foundry/openai/concepts/model-router",
        "https://learn.microsoft.com/azure/foundry/openai/how-to/model-router");
}

app.MapPost("/api/evaluations", async (EvaluationRequest request, IHttpClientFactory clientFactory, IConfiguration configuration) =>
{
    var results = new List<EvaluationResult>();
    foreach (var modelId in request.ModelIds.Distinct())
    {
        var model = catalog.FirstOrDefault(item => item.Id == modelId);
        if (model is null) continue;

        if (request.Mode.Equals("demo", StringComparison.OrdinalIgnoreCase))
        {
            var demoOutputs = CreateDemoOutputs(model, request.Samples, []);
            var usage = EstimateDemoUsage(request.Samples, demoOutputs, 0);
            results.Add(new(model.Id, model.Name, "completed", DemoLatency(model), demoOutputs, "Simulated demo run; no provider was contacted.", usage, EstimateCost(model, usage), true));
            continue;
        }

        var connector = ResolveConnector(request.Connection, model.Provider);
        var endpoint = configuration[$"Providers:{connector}:Endpoint"];
        var apiKey = configuration[$"Providers:{connector}:ApiKey"];
        var authentication = configuration[$"Providers:{connector}:Authentication"] ?? "ApiKey";
        if (string.IsNullOrWhiteSpace(endpoint) || (!authentication.Equals("EntraId", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(apiKey)))
        {
            results.Add(new(model.Id, model.Name, "connector-required", null, [],
            $"Configure the {connector} endpoint and authentication on the server."));
            continue;
        }

        var outputs = new List<string>();
        var inputTokens = 0;
        var outputTokens = 0;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var client = clientFactory.CreateClient();
            await ConfigureProviderClientAsync(client, configuration, connector, apiKey);
            var deployedModel = ResolveDeployedModel(configuration, connector, model.Id);
            foreach (var sample in request.Samples.Where(value => !string.IsNullOrWhiteSpace(value)).Take(20))
            {
                using var response = await client.PostAsJsonAsync(endpoint, new
                {
                    model = deployedModel,
                    messages = new[] { new { role = "user", content = sample } },
                    temperature = 0
                });
                response.EnsureSuccessStatusCode();
                using var payload = await System.Text.Json.JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync());
                outputs.Add(payload.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "");
                if (payload.RootElement.TryGetProperty("usage", out var usagePayload))
                {
                    inputTokens += ReadTokenCount(usagePayload, "prompt_tokens", "input_tokens");
                    outputTokens += ReadTokenCount(usagePayload, "completion_tokens", "output_tokens");
                }
            }
            stopwatch.Stop();
            var usage = inputTokens + outputTokens > 0 ? new TokenUsage(inputTokens, outputTokens, inputTokens + outputTokens) : null;
            results.Add(new(model.Id, model.Name, "completed", Math.Round(stopwatch.Elapsed.TotalMilliseconds / Math.Max(outputs.Count, 1)), outputs.ToArray(), null, usage, usage is null ? null : EstimateCost(model, usage), false));
        }
        catch (Exception exception)
        {
            results.Add(new(model.Id, model.Name, "failed", null, outputs.ToArray(), exception.Message));
        }
    }

    return Results.Ok(new EvaluationResponse(DateTimeOffset.UtcNow, results.ToArray(), BuildVerdict(results, catalog)));
});

app.MapPost("/api/evaluations/media", async (HttpRequest request, IHttpClientFactory clientFactory, IConfiguration configuration) =>
{
    const long maxFileBytes = 25 * 1024 * 1024;
    if (!request.HasFormContentType)
        return Results.BadRequest(new { message = "Use multipart/form-data for media evaluations." });

    var form = await request.ReadFormAsync();
    var modelIds = System.Text.Json.JsonSerializer.Deserialize<string[]>(form["modelIds"].ToString()) ?? [];
    var samples = System.Text.Json.JsonSerializer.Deserialize<string[]>(form["samples"].ToString()) ?? [];
    var files = form.Files.Take(8).ToArray();
    var invalidFile = files.FirstOrDefault(file =>
        file.Length == 0 ||
        file.Length > maxFileBytes ||
        !IsSupportedMediaFile(file));

    if (form.Files.Count > 8)
        return Results.BadRequest(new { message = "A maximum of 8 files is allowed per evaluation." });
    if (invalidFile is not null)
        return Results.BadRequest(new { message = $"{invalidFile.FileName} is empty, larger than 25 MB, or unsupported. Use PDF, TXT, MD, CSV, JSON, JPG, JPEG, PNG, WEBP, GIF, MP3, WAV, M4A, OGG, WEBM, MP4, or MOV." });
    if (modelIds.Length == 0 || (samples.Length == 0 && files.Length == 0))
        return Results.BadRequest(new { message = "Select at least one model and provide text or media data." });

    var assets = files.Select(file => new EvaluationAsset(file.FileName, file.ContentType, file.Length)).ToArray();
    var results = new List<EvaluationResult>();
    foreach (var modelId in modelIds.Distinct())
    {
        var model = catalog.FirstOrDefault(item => item.Id == modelId);
        if (model is null) continue;

        var unsupportedTypes = files
            .Select(file => GetModality(file.ContentType))
            .Where(modality => !model.Modalities.Contains(modality, StringComparer.OrdinalIgnoreCase))
            .Distinct()
            .ToArray();
        if (unsupportedTypes.Length > 0)
        {
            results.Add(new(model.Id, model.Name, "unsupported-modality", null, [],
                $"This model does not accept: {string.Join(", ", unsupportedTypes)}."));
            continue;
        }

        if (form["mode"].ToString().Equals("demo", StringComparison.OrdinalIgnoreCase))
        {
            var demoOutputs = CreateDemoOutputs(model, samples, assets.Select(asset => asset.Name).ToArray());
            var usage = EstimateDemoUsage(samples, demoOutputs, assets.Length);
            results.Add(new(model.Id, model.Name, "completed", DemoLatency(model), demoOutputs, "Simulated demo run; no provider was contacted.", usage, EstimateCost(model, usage), true));
            continue;
        }

        var connector = ResolveConnector(form["connection"].ToString(), model.Provider);
        var endpoint = configuration[$"Providers:{connector}:MediaEndpoint"];
        var apiKey = configuration[$"Providers:{connector}:ApiKey"];
        var authentication = configuration[$"Providers:{connector}:Authentication"] ?? "ApiKey";
        if (string.IsNullOrWhiteSpace(endpoint) || (!authentication.Equals("EntraId", StringComparison.OrdinalIgnoreCase) && string.IsNullOrWhiteSpace(apiKey)))
        {
            results.Add(new(model.Id, model.Name, "connector-required", null, [],
            $"Accepted {assets.Length} file(s). Configure the {connector} media endpoint and authentication to run them."));
            continue;
        }

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            using var client = clientFactory.CreateClient();
            await ConfigureProviderClientAsync(client, configuration, connector, apiKey);
            using var payload = new MultipartFormDataContent();
            payload.Add(new StringContent(ResolveDeployedModel(configuration, connector, model.Id)), "model");
            payload.Add(new StringContent(System.Text.Json.JsonSerializer.Serialize(samples)), "samples");
            foreach (var file in files)
            {
                var content = new StreamContent(file.OpenReadStream());
                content.Headers.ContentType = new(file.ContentType);
                payload.Add(content, "files", file.FileName);
            }

            using var response = await client.PostAsync(endpoint, payload);
            response.EnsureSuccessStatusCode();
            var output = await response.Content.ReadAsStringAsync();
            stopwatch.Stop();
            results.Add(new(model.Id, model.Name, "completed", Math.Round(stopwatch.Elapsed.TotalMilliseconds), [output], null));
        }
        catch (Exception exception)
        {
            results.Add(new(model.Id, model.Name, "failed", null, [], exception.Message));
        }
    }

    return Results.Ok(new MediaEvaluationResponse(DateTimeOffset.UtcNow, assets, results.ToArray(), BuildVerdict(results, catalog)));
});

static bool IsSupportedMediaFile(IFormFile file)
{
    var extension = Path.GetExtension(file.FileName).ToLowerInvariant();
    var contentType = file.ContentType.Split(';')[0].ToLowerInvariant();
    return extension switch
    {
        ".pdf" => contentType == "application/pdf",
        ".txt" => contentType == "text/plain",
        ".md" => contentType is "text/markdown" or "text/plain",
        ".csv" => contentType == "text/csv",
        ".json" => contentType == "application/json",
        ".jpg" or ".jpeg" => contentType == "image/jpeg",
        ".png" => contentType == "image/png",
        ".webp" => contentType == "image/webp",
        ".gif" => contentType == "image/gif",
        ".mp3" => contentType == "audio/mpeg",
        ".wav" => contentType is "audio/wav" or "audio/x-wav",
        ".m4a" => contentType == "audio/mp4",
        ".ogg" => contentType == "audio/ogg",
        ".webm" => contentType is "audio/webm" or "video/webm",
        ".mp4" => contentType == "video/mp4",
        ".mov" => contentType == "video/quicktime",
        _ => false
    };
}

static string GetModality(string contentType) => contentType.Split('/')[0] switch
{
    "image" => "vision",
    "audio" => "audio",
    "video" => "video",
    _ => "text"
};

static string ResolveConnector(string? connection, string modelProvider) => connection?.ToLowerInvariant() switch
{
    "microsoft" => "Microsoft",
    "openai" => "OpenAI",
    _ => modelProvider
};

static string ResolveDeployedModel(IConfiguration configuration, string connector, string modelId) =>
    configuration[$"Providers:{connector}:Models:{modelId}"] ??
    configuration[$"Providers:{connector}:Model"] ??
    modelId;

static async Task ConfigureProviderClientAsync(HttpClient client, IConfiguration configuration, string provider, string? apiKey)
{
    var authentication = configuration[$"Providers:{provider}:Authentication"] ?? "ApiKey";
    if (authentication.Equals("EntraId", StringComparison.OrdinalIgnoreCase))
    {
        var credential = new DefaultAzureCredential();
        var token = await credential.GetTokenAsync(new TokenRequestContext(["https://ai.azure.com/.default"]));
        client.DefaultRequestHeaders.Authorization = new("Bearer", token.Token);
        return;
    }

    var header = configuration[$"Providers:{provider}:ApiKeyHeader"] ??
        (provider.Equals("Microsoft", StringComparison.OrdinalIgnoreCase) ? "api-key" : "Authorization");
    if (header.Equals("Authorization", StringComparison.OrdinalIgnoreCase))
        client.DefaultRequestHeaders.Authorization = new("Bearer", apiKey!);
    else
        client.DefaultRequestHeaders.TryAddWithoutValidation(header, apiKey!);
}

static double DemoLatency(ModelCard model) => 180 + (100 - model.SpeedScore) * 9;

static int ReadTokenCount(System.Text.Json.JsonElement usage, string primaryName, string alternateName)
{
    if (usage.TryGetProperty(primaryName, out var primary) && primary.TryGetInt32(out var primaryValue)) return primaryValue;
    if (usage.TryGetProperty(alternateName, out var alternate) && alternate.TryGetInt32(out var alternateValue)) return alternateValue;
    return 0;
}

static TokenUsage EstimateDemoUsage(IEnumerable<string> samples, IEnumerable<string> outputs, int assetCount)
{
    var inputTokens = Math.Max(1, samples.Sum(sample => sample.Length) / 4 + assetCount * 256);
    var outputTokens = Math.Max(1, outputs.Sum(output => output.Length) / 4);
    return new(inputTokens, outputTokens, inputTokens + outputTokens);
}

static decimal EstimateCost(ModelCard model, TokenUsage usage) => Math.Round(
    usage.InputTokens * model.InputCostPerMillion / 1_000_000m +
    usage.OutputTokens * model.OutputCostPerMillion / 1_000_000m,
    6);

static EvaluationVerdict? BuildVerdict(IEnumerable<EvaluationResult> results, IEnumerable<ModelCard> catalog)
{
    var completed = results.Where(result => result.Status == "completed").ToArray();
    if (completed.Length == 0) return null;

    var measuredLatencies = completed.Where(result => result.AverageLatencyMs is > 0).Select(result => result.AverageLatencyMs!.Value).ToArray();
    var measuredCosts = completed.Where(result => result.EstimatedCostUsd is > 0).Select(result => result.EstimatedCostUsd!.Value).ToArray();
    var fastest = measuredLatencies.DefaultIfEmpty(0).Min();
    var cheapest = measuredCosts.DefaultIfEmpty(0).Min();

    var ranked = completed.Select(result =>
    {
        var model = catalog.First(item => item.Id == result.ModelId);
        var latencyScore = fastest > 0 && result.AverageLatencyMs is > 0 ? fastest / result.AverageLatencyMs.Value : 1;
        var costScore = cheapest > 0 && result.EstimatedCostUsd is > 0 ? (double)(cheapest / result.EstimatedCostUsd.Value) : 1;
        var score = model.QualityScore * 0.55 + latencyScore * 25 + costScore * 20;
        var reasons = new List<string> { $"{model.QualityScore}/100 catalog quality index" };
        if (result.AverageLatencyMs is > 0) reasons.Add($"{result.AverageLatencyMs:0} ms average latency");
        if (result.EstimatedCostUsd is not null) reasons.Add($"${result.EstimatedCostUsd:0.000000} estimated run cost");
        if (result.Usage is not null) reasons.Add($"{result.Usage.TotalTokens:N0} total tokens");
        return new EvaluationVerdict(model.Id, model.Name, Math.Round(score, 1), reasons.ToArray(), result.MetricsEstimated);
    }).OrderByDescending(verdict => verdict.Score).First();

    return ranked;
}

static string[] CreateDemoOutputs(ModelCard model, IEnumerable<string> samples, IEnumerable<string> assetNames)
{
    var prompts = samples.Where(value => !string.IsNullOrWhiteSpace(value)).Take(20)
        .Select((sample, index) => $"[Simulated {model.Name} response {index + 1}] I understood the request: \"{sample.Trim()}\". This is a demonstration response; connect the provider to evaluate answer quality.");
    var assets = assetNames.Select((name, index) => $"[Simulated {model.Name} media response {index + 1}] Processed {name} using the model's supported input modalities. Connect the provider for real analysis.");
    return prompts.Concat(assets).DefaultIfEmpty($"[Simulated {model.Name} response] Demo evaluation completed.").ToArray();
}

static Recommendation Score(ModelCard model, ProjectProfile profile)
{
    var totalWeight = profile.QualityWeight + profile.CostWeight + profile.SpeedWeight + profile.SafetyWeight;
    if (totalWeight <= 0) totalWeight = 1;

    var costScore = Math.Max(0, 100 - (double)model.InputCostPerMillion * 8);
    var weightedScore = (
        model.QualityScore * profile.QualityWeight +
        costScore * profile.CostWeight +
        model.SpeedScore * profile.SpeedWeight +
        model.SafetyScore * profile.SafetyWeight) / totalWeight;
    var taskFit = model.Operations.TaskTypes.Contains(profile.TaskType ?? "", StringComparer.OrdinalIgnoreCase) ? 100 : 65;
    var score = weightedScore * 0.9 + taskFit * 0.1;
    if (model.Operations.Lifecycle.Status.Equals("Deprecated", StringComparison.OrdinalIgnoreCase))
        score -= 25;

    var reasons = new List<string>
    {
        $"{model.QualityScore}/100 quality benchmark index",
        $"{model.SpeedScore}/100 relative speed index",
        $"${model.InputCostPerMillion:0.00} input per 1M tokens",
        $"${EstimateMonthlyCost(model, profile):0.00} projected monthly at {profile.CallsPerDay:N0} calls/day"
    };
    if (taskFit == 100) reasons.Add($"Strong fit for {profile.TaskType}");
    if (model.Regions.Contains(profile.Region, StringComparer.OrdinalIgnoreCase))
        reasons.Add($"Available in {profile.Region}");
    if (model.OpenSource)
        reasons.Add("Open-weight deployment option");
    if (model.Legal.RequiresAgreement)
        reasons.Add("Provider or community agreement required");
    else
        reasons.Add($"{model.Legal.LicenseName} terms");
    if (model.Operations.Lifecycle.Status.Equals("Deprecated", StringComparison.OrdinalIgnoreCase))
        reasons.Add($"Deprecated: migrate to {model.Operations.Lifecycle.Replacement ?? "a supported replacement"} before retirement");

    return new Recommendation(model, Math.Round(score, 1), reasons.ToArray());
}

app.Run();

record ProjectProfile(
    string UseCase,
    string? TaskType,
    string[] Modalities,
    string? LatencyRequirement,
    string? QualityBar,
    string Region,
    bool RequireDataResidency,
    int MinimumContext,
    decimal? MaxInputCostPerMillion,
    bool OpenSourceOnly,
    bool RequireSelfHosting,
    string? ComputePreference,
    bool RequireFineTuning,
    bool RequireStructuredJson,
    bool RequireToolCalling,
    bool RequireStreaming,
    bool ExcludeAgreementRequired,
    int CallsPerDay,
    int AverageInputTokens,
    int AverageOutputTokens,
    decimal? MonthlyBudgetUsd,
    int QualityWeight,
    int CostWeight,
    int SpeedWeight,
    int SafetyWeight);

record RecommendationResponse(Recommendation[] Recommendations, CostOptimization[] CostOptimizations, FoundryModelRouterRecommendation ModelRouter, string? Message);
record Recommendation(ModelCard Model, double Score, string[] Reasons);
record CostOptimization(string Title, string Detail, decimal EstimatedMonthlySavingsUsd, string ModelId);
record FoundryModelRouterRecommendation(
    string ModelName,
    string Version,
    string RoutingMode,
    string Summary,
    string[] Benefits,
    string[] Requirements,
    string SourceUrl,
    string DeploymentUrl);
record CatalogResponse(DateTimeOffset UpdatedAt, ModelCard[] Models, SourceReference[] Sources);
record SourceReference(string Provider, string Url, string RefreshMode, DateTimeOffset CheckedAt);
record EvaluationRequest(string[] ModelIds, string[] Samples, string Mode = "live", string Connection = "catalog");
record EvaluationResponse(DateTimeOffset CompletedAt, EvaluationResult[] Results, EvaluationVerdict? Verdict);
record EvaluationResult(string ModelId, string ModelName, string Status, double? AverageLatencyMs, string[] Outputs, string? Message, TokenUsage? Usage = null, decimal? EstimatedCostUsd = null, bool MetricsEstimated = false);
record TokenUsage(int InputTokens, int OutputTokens, int TotalTokens);
record EvaluationVerdict(string ModelId, string ModelName, double Score, string[] Reasons, bool MetricsEstimated);
record MediaEvaluationResponse(DateTimeOffset CompletedAt, EvaluationAsset[] Assets, EvaluationResult[] Results, EvaluationVerdict? Verdict);
record EvaluationAsset(string Name, string ContentType, long SizeBytes);

record ModelCard(
    string Id,
    string Name,
    string Provider,
    string[] Modalities,
    int ContextWindow,
    decimal InputCostPerMillion,
    decimal OutputCostPerMillion,
    int QualityScore,
    int SpeedScore,
    int SafetyScore,
    bool OpenSource,
    bool SelfHostable,
    string License,
    string[] Regions,
    string BestFor,
    string SourceUrl,
    LegalInfo Legal)
{
    public ModelEvidence Evidence => ModelEvidenceCatalog.For(Id, QualityScore, SpeedScore, SafetyScore, SourceUrl);
    public OperationalEvidence Operations => OperationalEvidenceCatalog.For(Id, SelfHostable, SourceUrl);
}

record LegalInfo(
    string LicenseName,
    string Category,
    bool RequiresAgreement,
    string CommercialUse,
    string[] Constraints,
    string TermsUrl);

record ModelEvidence(
    BenchmarkSignal[] Benchmarks,
    ToolUseInfo ToolUse,
    string[] SpeechLanguages,
    string[] KnownWeaknesses);

record BenchmarkSignal(string Name, string Value, string Methodology, string SourceUrl);
record ToolUseInfo(bool Supported, bool NativeFunctionCalling, bool ParallelCalls, string Summary);
record OperationalEvidence(
    string[] TaskTypes,
    OutputCapabilities Output,
    ComputeCapabilities Compute,
    LifecycleInfo Lifecycle,
    AccessInfo Access);
record OutputCapabilities(bool StructuredJson, bool Streaming, string Summary);
record ComputeCapabilities(bool ManagedCompute, bool SelfHostedGpu, int? MinimumGpuMemoryGb, bool FineTuningSupported, string Summary);
record LifecycleInfo(string Status, string? ModelVersion, DateTimeOffset? ReleasedAt, DateTimeOffset? DeprecationDate, DateTimeOffset? RetirementDate, int? DaysUntilRetirement, string Urgency, string? Replacement, string Summary, string SourceUrl, DateTimeOffset CheckedAt);
record AccessInfo(bool Gated, string AccessType, string ApplyUrl, string Summary);

static class OperationalEvidenceCatalog
{
    public static OperationalEvidence For(string modelId, bool selfHostable, string sourceUrl)
    {
        var taskTypes = modelId switch
        {
            "gpt-5" => new[] { "chat", "coding", "summarization", "classification", "agentic", "rag" },
            "gpt-4.1-mini" => new[] { "chat", "summarization", "classification", "agentic", "rag", "vision" },
            "gpt-4o-2024-05-13" => new[] { "chat", "summarization", "classification", "agentic", "rag", "vision" },
            "phi-4" => new[] { "chat", "coding", "summarization", "classification", "rag" },
            "claude-sonnet-4" => new[] { "chat", "coding", "summarization", "agentic", "rag", "vision" },
            "gemini-2.5-pro" => new[] { "chat", "coding", "summarization", "agentic", "rag", "vision" },
            "llama-4-maverick" => new[] { "chat", "summarization", "classification", "rag", "vision" },
            "mistral-large-3" => new[] { "chat", "coding", "summarization", "classification", "agentic", "rag", "vision" },
            _ => new[] { "chat", "coding", "summarization", "classification", "rag" }
        };
        var nativeOutput = modelId is "gpt-5" or "gpt-4.1-mini" or "gpt-4o-2024-05-13" or "claude-sonnet-4" or "gemini-2.5-pro" or "mistral-large-3";
        var fineTuning = modelId is "gpt-4.1-mini" or "phi-4" or "llama-4-maverick" or "mistral-large-3" or "deepseek-v3.1";
        var minimumGpuMemory = modelId switch
        {
            "phi-4" => 32,
            "llama-4-maverick" => 320,
            "mistral-large-3" => 160,
            "deepseek-v3.1" => 640,
            _ => (int?)null
        };
        var output = new OutputCapabilities(nativeOutput, true, nativeOutput
            ? "Native structured output and token streaming are supported."
            : "Streaming is supported; JSON reliability depends on the serving stack and constrained decoding.");
        var compute = new ComputeCapabilities(!selfHostable || modelId != "deepseek-v3.1", selfHostable, minimumGpuMemory, fineTuning,
            selfHostable
                ? $"Managed hosting may be available; self-hosting starts around {minimumGpuMemory} GB aggregate GPU memory and varies by precision."
                : "Use provider-managed compute; model weights are not available for self-hosting.");
        var releasedAt = modelId switch
        {
            "gpt-5" => new DateTimeOffset(2025, 8, 7, 0, 0, 0, TimeSpan.Zero),
            "gpt-4.1-mini" => new DateTimeOffset(2025, 4, 14, 0, 0, 0, TimeSpan.Zero),
            "phi-4" => new DateTimeOffset(2024, 12, 12, 0, 0, 0, TimeSpan.Zero),
            "claude-sonnet-4" => new DateTimeOffset(2025, 5, 22, 0, 0, 0, TimeSpan.Zero),
            "gemini-2.5-pro" => new DateTimeOffset(2025, 6, 17, 0, 0, 0, TimeSpan.Zero),
            "llama-4-maverick" => new DateTimeOffset(2025, 4, 5, 0, 0, 0, TimeSpan.Zero),
            "deepseek-v3.1" => new DateTimeOffset(2025, 8, 21, 0, 0, 0, TimeSpan.Zero),
            _ => (DateTimeOffset?)null
        };
        var lifecycle = modelId switch
        {
            "gpt-4o-2024-05-13" => new LifecycleInfo(
                "Deprecated", "2024-05-13", new DateTimeOffset(2024, 5, 13, 0, 0, 0, TimeSpan.Zero), null,
                new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero), 12, "Retires soon", "GPT-5.1",
                "This Azure OpenAI model version is nearing retirement. Evaluate and migrate dependent workloads before the retirement date.",
                "https://learn.microsoft.com/azure/foundry/openai/concepts/model-retirement-schedule", ModelCatalog.UpdatedAt),
            _ => new LifecycleInfo("Active", null, releasedAt, null, null, null, "Current", null,
                "No planned retirement is recorded in this catalog snapshot. Recheck the linked provider source before production deployment.",
                sourceUrl, ModelCatalog.UpdatedAt)
        };
        var access = modelId switch
        {
            "llama-4-maverick" => new AccessInfo(true, "License-gated weights", "https://huggingface.co/meta-llama", "Sign in to Hugging Face, accept Meta's license, and submit the repository access request."),
            "gpt-5" or "gpt-4.1-mini" => new AccessInfo(false, "Provider account", "https://platform.openai.com/", "Create a provider project and confirm model availability for the account tier and region."),
            "gpt-4o-2024-05-13" => new AccessInfo(false, "Microsoft Foundry deployment", "https://ai.azure.com/explore/models", "Use an existing Azure OpenAI deployment only while migrating to the published replacement."),
            "claude-sonnet-4" => new AccessInfo(false, "Provider account", "https://console.anthropic.com/", "Create an Anthropic Console account or request the model through the selected cloud marketplace."),
            "gemini-2.5-pro" => new AccessInfo(false, "Provider account", "https://aistudio.google.com/", "Create a Google AI Studio or Vertex AI project and enable the model in an eligible region."),
            _ => new AccessInfo(false, selfHostable ? "Open weights" : "Provider account", sourceUrl, selfHostable ? "Download under the linked model license; a hosting platform may impose separate access controls." : "Follow the linked provider onboarding flow.")
        };
        return new(taskTypes, output, compute, lifecycle, access);
    }
}

static class ModelEvidenceCatalog
{
    public static ModelEvidence For(string modelId, int quality, int speed, int safety, string sourceUrl)
    {
        var benchmarks = new[]
        {
            new BenchmarkSignal("Quality composite", $"{quality}/100", "Model Compass normalized baseline; validate on your task-specific dataset.", sourceUrl),
            new BenchmarkSignal("Relative speed", $"{speed}/100", "Catalog-relative index, not a provider latency guarantee.", sourceUrl),
            new BenchmarkSignal("Safety composite", $"{safety}/100", "Catalog baseline; production policy and red-team evaluation are still required.", sourceUrl)
        };

        return modelId switch
        {
            "gpt-5" => new(benchmarks, new(true, true, true, "Native function calling, structured outputs, and parallel tool orchestration."), [], ["Higher output-token cost than compact models", "Provider-hosted; no self-hosted weights", "Can still hallucinate tool arguments or over-reason"]),
            "gpt-4.1-mini" => new(benchmarks, new(true, true, true, "Native function calling and structured outputs for high-volume agents."), [], ["Lower reasoning depth than frontier models", "Provider-hosted; no self-hosted weights", "Visual and long-context accuracy remains task-dependent"]),
            "gpt-4o-2024-05-13" => new(benchmarks, new(true, true, true, "Native function calling and structured outputs on this legacy model version."), [], ["Deprecated in Microsoft Foundry", "Retires October 1, 2026", "Migration testing is required before moving to GPT-5.1"]),
            "phi-4" => new(benchmarks, new(false, false, false, "Tool use is orchestration- and prompt-template-dependent rather than a native guarantee."), [], ["Text and code only in this catalog entry", "Smaller context window", "Tool-call reliability depends on the serving stack"]),
            "claude-sonnet-4" => new(benchmarks, new(true, true, true, "Native tool use with parallel calls and schema-defined inputs."), [], ["Premium input and output pricing", "Provider-hosted; no self-hosted weights", "Long agent loops need explicit budgets and guardrails"]),
            "gemini-2.5-pro" => new(benchmarks, new(true, true, true, "Function calling supports multimodal and parallel tool workflows."), ["Arabic", "Chinese", "English", "French", "German", "Hindi", "Indonesian", "Italian", "Japanese", "Korean", "Portuguese", "Russian", "Spanish", "Thai", "Turkish", "Vietnamese"], ["Multimodal latency can rise with large files", "Provider-hosted; no self-hosted weights", "Speech quality and language coverage should be tested for accent and domain"]),
            "llama-4-maverick" => new(benchmarks, new(true, false, false, "Structured tool calls depend on the host, chat template, and orchestration framework."), [], ["Tool behavior varies by serving implementation", "Community license conditions apply", "Self-hosting requires capacity planning and safety controls"]),
            "mistral-large-3" => new(benchmarks, new(true, true, true, "Function calling is available; verify parallel-call behavior with the selected host."), [], ["Regional and hosting feature parity can vary", "Self-hosted performance depends on quantization and hardware", "Task-specific safety tuning may be required"]),
            "deepseek-v3.1" => new(benchmarks, new(true, false, false, "Tool-call formatting is deployment- and template-dependent."), [], ["Text and code only in this catalog entry", "Tool-call reliability varies across serving stacks", "Self-hosted governance and safety controls are your responsibility"]),
            _ => new(benchmarks, new(false, false, false, "No verified tool-use capability in the current catalog snapshot."), [], ["No curated weakness profile is available; run task-specific evaluation."])
        };
    }
}

static class ModelCatalog
{
    public static readonly DateTimeOffset UpdatedAt = new(2026, 9, 19, 0, 0, 0, TimeSpan.Zero);

    public static readonly SourceReference[] Sources =
    [
        new("Microsoft Foundry", "https://ai.azure.com/explore/models", "Catalog connector", UpdatedAt),
        new("OpenAI", "https://platform.openai.com/docs/models", "Provider API", UpdatedAt),
        new("Anthropic", "https://docs.anthropic.com/en/docs/about-claude/models", "Provider API", UpdatedAt),
        new("Google", "https://ai.google.dev/gemini-api/docs/models", "Provider API", UpdatedAt),
        new("Hugging Face", "https://huggingface.co/models", "Public API", UpdatedAt)
    ];

    public static readonly ModelCard[] All =
    [
        new("gpt-5", "GPT-5", "OpenAI", ["text", "vision", "code"], 400000, 1.25m, 10m, 95, 72, 92, false, false, "Commercial", ["East US 2", "Sweden Central", "Global"], "Complex reasoning and coding", "https://platform.openai.com/docs/models", new("OpenAI Services Agreement", "Commercial API", true, "Commercial use under provider terms", ["Service agreement and usage policies apply", "Restricted and high-impact uses require additional review", "Rights and indemnity vary by service plan"], "https://openai.com/policies/business-terms/")),
        new("gpt-4.1-mini", "GPT-4.1 mini", "OpenAI", ["text", "vision", "code"], 1000000, 0.40m, 1.60m, 84, 91, 90, false, false, "Commercial", ["East US", "East US 2", "Sweden Central", "Global"], "High-volume multimodal applications", "https://platform.openai.com/docs/models", new("OpenAI Services Agreement", "Commercial API", true, "Commercial use under provider terms", ["Service agreement and usage policies apply", "Restricted and high-impact uses require additional review", "Rights and indemnity vary by service plan"], "https://openai.com/policies/business-terms/")),
        new("gpt-4o-2024-05-13", "GPT-4o (2024-05-13)", "Azure OpenAI", ["text", "vision", "code"], 128000, 5m, 15m, 88, 78, 90, false, false, "Commercial", ["East US", "East US 2", "Sweden Central", "Global"], "Existing workloads requiring an urgent migration plan", "https://learn.microsoft.com/azure/foundry/openai/concepts/model-retirement-schedule", new("Microsoft Product Terms", "Commercial cloud service", true, "Commercial use under Microsoft terms", ["Microsoft Product Terms and acceptable-use policies apply", "Availability varies by deployment type and region", "This version is deprecated and should not be selected for new workloads"], "https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA")),
        new("phi-4", "Phi-4", "Microsoft", ["text", "code"], 16384, 0.13m, 0.50m, 78, 94, 86, true, true, "MIT", ["East US", "West Europe", "Self-hosted"], "Efficient reasoning and edge workloads", "https://huggingface.co/microsoft/phi-4", new("MIT License", "Permissive open-weight", false, "Commercial use permitted", ["Preserve copyright and license notice", "A hosting provider's separate service terms may apply"], "https://huggingface.co/microsoft/phi-4/blob/main/LICENSE")),
        new("claude-sonnet-4", "Claude Sonnet 4", "Anthropic", ["text", "vision", "code"], 200000, 3m, 15m, 94, 76, 94, false, false, "Commercial", ["US", "Europe", "Global"], "Long-form analysis and agentic coding", "https://docs.anthropic.com/en/docs/about-claude/models", new("Anthropic Commercial Terms", "Commercial API", true, "Commercial use under provider terms", ["Commercial terms and usage policy apply", "High-risk use cases may require safeguards or approval", "Service-specific restrictions may apply"], "https://www.anthropic.com/legal/commercial-terms")),
        new("gemini-2.5-pro", "Gemini 2.5 Pro", "Google", ["text", "vision", "audio", "video", "code"], 1048576, 1.25m, 10m, 93, 74, 90, false, false, "Commercial", ["US", "Europe", "Global"], "Large-context multimodal reasoning", "https://ai.google.dev/gemini-api/docs/models", new("Gemini API Additional Terms", "Commercial API", true, "Commercial use under provider terms", ["Google API and generative AI terms apply", "Prohibited-use policy applies", "Data-use terms vary by service and billing status"], "https://ai.google.dev/gemini-api/terms")),
        new("llama-4-maverick", "Llama 4 Maverick", "Meta", ["text", "vision", "code"], 1048576, 0.25m, 0.75m, 87, 82, 83, true, true, "Llama 4 Community", ["East US", "Sweden Central", "Self-hosted"], "Open-weight multimodal applications", "https://huggingface.co/meta-llama", new("Llama 4 Community License", "Community open-weight", true, "Commercial use with conditions", ["License acceptance and attribution are required", "Acceptable Use Policy applies", "Organizations above the stated monthly-active-user threshold need a separate Meta license"], "https://github.com/meta-llama/llama-models/blob/main/models/llama4/LICENSE")),
        new("mistral-large-3", "Mistral Large 3", "Mistral AI", ["text", "vision", "code"], 256000, 0.50m, 1.50m, 89, 84, 85, true, true, "Apache 2.0", ["France Central", "West Europe", "Self-hosted"], "Multilingual enterprise workloads", "https://docs.mistral.ai/getting-started/models/models_overview/", new("Apache License 2.0", "Permissive open-weight", false, "Commercial use permitted", ["Preserve license and notices", "State significant modifications", "Patent and trademark clauses apply"], "https://www.apache.org/licenses/LICENSE-2.0")),
        new("deepseek-v3.1", "DeepSeek V3.1", "DeepSeek", ["text", "code"], 128000, 0.27m, 1.10m, 90, 80, 78, true, true, "MIT", ["Self-hosted"], "Cost-sensitive reasoning and coding", "https://huggingface.co/deepseek-ai", new("MIT License", "Permissive open-weight", false, "Commercial use permitted", ["Preserve copyright and license notice", "Verify model-card restrictions and local regulatory requirements"], "https://github.com/deepseek-ai/DeepSeek-V3/blob/main/LICENSE-CODE"))
    ];
}
