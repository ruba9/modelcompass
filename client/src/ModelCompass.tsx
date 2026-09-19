import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  BarChart3,
  Check,
  ChevronRight,
  CircleGauge,
  Database,
  ExternalLink,
  FileText,
  FlaskConical,
  Globe2,
  Image,
  Layers3,
  Languages,
  LoaderCircle,
  Mic,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  Square,
  Trophy,
  Upload,
  Video,
  Wrench,
  X,
} from "lucide-react";
import "./Workspace.css";

type Step = "requirements" | "compare" | "evaluate";
type Profile = {
  useCase: string;
  taskType: string;
  modalities: string[];
  latencyRequirement: string;
  qualityBar: string;
  region: string;
  requireDataResidency: boolean;
  minimumContext: number;
  maxInputCostPerMillion: number | null;
  openSourceOnly: boolean;
  requireSelfHosting: boolean;
  computePreference: string;
  requireFineTuning: boolean;
  requireStructuredJson: boolean;
  requireToolCalling: boolean;
  requireStreaming: boolean;
  excludeAgreementRequired: boolean;
  callsPerDay: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  monthlyBudgetUsd: number | null;
  qualityWeight: number;
  costWeight: number;
  speedWeight: number;
  safetyWeight: number;
};
type LegalInfo = {
  licenseName: string;
  category: string;
  requiresAgreement: boolean;
  commercialUse: string;
  constraints: string[];
  termsUrl: string;
};
type BenchmarkSignal = { name: string; value: string; methodology: string; sourceUrl: string };
type ModelEvidence = {
  benchmarks: BenchmarkSignal[];
  toolUse: { supported: boolean; nativeFunctionCalling: boolean; parallelCalls: boolean; summary: string };
  speechLanguages: string[];
  knownWeaknesses: string[];
};
type OperationalEvidence = {
  taskTypes: string[];
  output: { structuredJson: boolean; streaming: boolean; summary: string };
  compute: { managedCompute: boolean; selfHostedGpu: boolean; minimumGpuMemoryGb: number | null; fineTuningSupported: boolean; summary: string };
  lifecycle: { status: string; modelVersion: string | null; releasedAt: string | null; deprecationDate: string | null; retirementDate: string | null; daysUntilRetirement: number | null; urgency: string; replacement: string | null; summary: string; sourceUrl: string; checkedAt: string };
  access: { gated: boolean; accessType: string; applyUrl: string; summary: string };
};
type ModelCard = {
  id: string;
  name: string;
  provider: string;
  modalities: string[];
  contextWindow: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  qualityScore: number;
  speedScore: number;
  safetyScore: number;
  openSource: boolean;
  selfHostable: boolean;
  license: string;
  regions: string[];
  bestFor: string;
  sourceUrl: string;
  legal: LegalInfo;
  evidence: ModelEvidence;
  operations: OperationalEvidence;
};
type Recommendation = { model: ModelCard; score: number; reasons: string[] };
type CostOptimization = { title: string; detail: string; estimatedMonthlySavingsUsd: number; modelId: string };
type FoundryModelRouter = { modelName: string; version: string; routingMode: string; summary: string; benefits: string[]; requirements: string[]; sourceUrl: string; deploymentUrl: string };
type EvaluationResult = {
  modelId: string;
  modelName: string;
  status: string;
  averageLatencyMs: number | null;
  outputs: string[];
  message: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  estimatedCostUsd: number | null;
  metricsEstimated: boolean;
};
type EvaluationVerdict = { modelId: string; modelName: string; score: number; reasons: string[]; metricsEstimated: boolean };
type EvaluationMode = "demo" | "live";

const API_URL = "http://localhost:5070/api";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 8;
const ACCEPTED_FILES = ".pdf,.txt,.md,.csv,.json,.jpg,.jpeg,.png,.webp,.gif,.mp3,.wav,.m4a,.ogg,.webm,.mp4,.mov";
const ACCEPTED_FILE_TYPES: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".csv": ["text/csv"],
  ".json": ["application/json"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".gif": ["image/gif"],
  ".mp3": ["audio/mpeg"],
  ".wav": ["audio/wav", "audio/x-wav"],
  ".m4a": ["audio/mp4"],
  ".ogg": ["audio/ogg"],
  ".webm": ["audio/webm", "video/webm"],
  ".mp4": ["video/mp4"],
  ".mov": ["video/quicktime"],
};
const fileExtension = (file: File) =>
  `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
const isAcceptedFile = (file: File) =>
  ACCEPTED_FILE_TYPES[fileExtension(file)]?.includes(
    file.type.split(";")[0].toLowerCase(),
  ) ?? false;
const fileModality = (file: File) => {
  const contentType = file.type.split(";")[0].toLowerCase();
  if (contentType.startsWith("image/")) return "vision";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "text";
};
const steps: { id: Step; label: string; detail: string }[] = [
  {
    id: "requirements",
    label: "Requirements",
    detail: "Use case and constraints",
  },
  { id: "compare", label: "Shortlist", detail: "Evidence and trade-offs" },
  { id: "evaluate", label: "Evaluate", detail: "Test with your examples" },
];
const initialProfile: Profile = {
  useCase:
    "Build a grounded customer-support assistant that answers from product documentation.",
  taskType: "rag",
  modalities: ["text"],
  latencyRequirement: "interactive",
  qualityBar: "high",
  region: "East US",
  requireDataResidency: true,
  minimumContext: 16000,
  maxInputCostPerMillion: 3,
  openSourceOnly: false,
  requireSelfHosting: false,
  computePreference: "any",
  requireFineTuning: false,
  requireStructuredJson: false,
  requireToolCalling: false,
  requireStreaming: true,
  excludeAgreementRequired: false,
  callsPerDay: 1000,
  averageInputTokens: 1500,
  averageOutputTokens: 400,
  monthlyBudgetUsd: 500,
  qualityWeight: 40,
  costWeight: 20,
  speedWeight: 20,
  safetyWeight: 20,
};

export default function ModelCompass() {
  const [step, setStep] = useState<Step>("requirements");
  const [profile, setProfile] = useState(initialProfile);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [costOptimizations, setCostOptimizations] = useState<CostOptimization[]>([]);
  const [modelRouter, setModelRouter] = useState<FoundryModelRouter | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [samples, setSamples] = useState(
    "How do I reset a device without losing settings?\nSummarize the warranty policy in three bullets.",
  );
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const [evaluationResults, setEvaluationResults] = useState<
    EvaluationResult[]
  >([]);
  const [evaluationVerdict, setEvaluationVerdict] = useState<EvaluationVerdict | null>(null);
  const [evaluationMode, setEvaluationMode] = useState<EvaluationMode>("demo");
  const [liveConnection, setLiveConnection] = useState<"microsoft" | "openai">(
    "microsoft",
  );
  const [files, setFiles] = useState<File[]>([]);
  const [recording, setRecording] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const uploadedModalities = [...new Set(files.map(fileModality))];
  const incompatibleModels = recommendations
    .filter((item) => selectedModels.includes(item.model.id))
    .map((item) => ({
      name: item.model.name,
      unsupported: uploadedModalities.filter(
        (modality) => !item.model.modalities.includes(modality),
      ),
    }))
    .filter((item) => item.unsupported.length > 0);

  const update = <Key extends keyof Profile>(key: Key, value: Profile[Key]) =>
    setProfile((current) => ({ ...current, [key]: value }));
  const findModels = async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`${API_URL}/recommendations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setRecommendations(data.recommendations);
      setCostOptimizations(data.costOptimizations ?? []);
      setModelRouter(data.modelRouter ?? null);
      setSelectedModels(
        data.recommendations
          .slice(0, 3)
          .map((item: Recommendation) => item.model.id),
      );
      setMessage(data.message ?? "");
      setStep("compare");
    } catch {
      setMessage("Start the API on port 5070, then try the analysis again.");
    } finally {
      setLoading(false);
    }
  };
  const toggleModel = (id: string) => {
    setSelectedModels((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
    setEvaluationResults([]);
    setEvaluationVerdict(null);
  };
  const addFiles = (incoming: File[]) => {
    const empty = incoming.filter((file) => file.size === 0);
    const oversized = incoming.filter((file) => file.size > MAX_FILE_BYTES);
    const unsupported = incoming.filter(
      (file) =>
        file.size > 0 &&
        file.size <= MAX_FILE_BYTES &&
        !isAcceptedFile(file),
    );
    const availableSlots = Math.max(0, MAX_FILES - files.length);
    const accepted = incoming
      .filter(
        (file) =>
          file.size > 0 &&
          file.size <= MAX_FILE_BYTES &&
          isAcceptedFile(file),
      )
      .slice(0, availableSlots);
    const omittedCount = incoming.length - empty.length - oversized.length - unsupported.length - accepted.length;
    const issues = [
      empty.length ? `${empty.map((file) => file.name).join(", ")} are empty` : "",
      oversized.length ? `${oversized.map((file) => file.name).join(", ")} exceed 25 MB` : "",
      unsupported.length ? `${unsupported.map((file) => file.name).join(", ")} use unsupported formats` : "",
      omittedCount > 0 ? `Only ${MAX_FILES} files can be added` : "",
    ].filter(Boolean);
    setFiles((current) => [...current, ...accepted]);
    setEvaluationResults([]);
    setEvaluationVerdict(null);
    setMessage(issues.join(". "));
  };
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingChunks.current = [];
      recorder.current = new MediaRecorder(stream);
      recorder.current.ondataavailable = (event) =>
        recordingChunks.current.push(event.data);
      recorder.current.onstop = () => {
        const blob = new Blob(recordingChunks.current, {
          type: recorder.current?.mimeType || "audio/webm",
        });
        addFiles([
          new File([blob], `recording-${Date.now()}.webm`, { type: blob.type }),
        ]);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.current.start();
      setRecording(true);
    } catch {
      setMessage(
        "Microphone access was not granted. You can upload an audio file instead.",
      );
    }
  };
  const stopRecording = () => {
    recorder.current?.stop();
    setRecording(false);
  };
  const runEvaluation = async () => {
    if (incompatibleModels.length) {
      setMessage("Remove incompatible files or choose models that support every uploaded data type.");
      return;
    }
    setEvaluationRunning(true);
    setEvaluationResults([]);
    setEvaluationVerdict(null);
    try {
      const textSamples = samples.split("\n").filter(Boolean);
      let response: Response;
      if (files.length) {
        const form = new FormData();
        form.append("modelIds", JSON.stringify(selectedModels));
        form.append("samples", JSON.stringify(textSamples));
        form.append("mode", evaluationMode);
        form.append("connection", liveConnection);
        files.forEach((file) => form.append("files", file));
        response = await fetch(`${API_URL}/evaluations/media`, {
          method: "POST",
          body: form,
        });
      } else {
        response = await fetch(`${API_URL}/evaluations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            modelIds: selectedModels,
            samples: textSamples,
            mode: evaluationMode,
            connection: liveConnection,
          }),
        });
      }
      if (!response.ok) throw new Error((await response.json()).message);
      const data = await response.json();
      setEvaluationResults(data.results);
      setEvaluationVerdict(data.verdict ?? null);
    } catch (error) {
      setMessage(
        error instanceof Error && error.message
          ? error.message
          : "The evaluation service could not be reached.",
      );
    } finally {
      setEvaluationRunning(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <Layers3 size={18} />
        </div>
        <div className="brand-copy">
          <strong>Model Compass</strong>
          <span>Decision workspace</span>
        </div>
        <div className="source-status">
          <span className="status-dot" />
          Catalog checked Sep 19, 2026
          <button
            className="icon-button"
            title="Refresh source status"
            aria-label="Refresh source status"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <div className="project-label">NEW ANALYSIS</div>
        <nav aria-label="Analysis steps">
          {steps.map((item, index) => (
            <button
              key={item.id}
              className={`step-button ${step === item.id ? "active" : ""}`}
              onClick={() => setStep(item.id)}
              disabled={
                item.id !== "requirements" && recommendations.length === 0
              }
            >
              <span className="step-number">{index + 1}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={17} />
          <p>
            <strong>Evidence first</strong>
            <span>
              Scores stay traceable to provider sources and update dates.
            </span>
          </p>
        </div>
      </aside>
      <main>
        {step === "requirements" && (
          <section className="workspace-section reveal">
            <Heading
              eyebrow="PROJECT PROFILE"
              title="What does your AI system need to do?"
              copy="Define hard constraints first. Preferences shape the ranking after unsuitable models are removed."
              index="01"
            />
            <div className="form-grid">
              <div className="panel">
                <PanelTitle icon={<Sparkles size={17} />} label="Task" detail="Primary workload" />
                <select aria-label="Task type" value={profile.taskType} onChange={(event) => update("taskType", event.target.value)}>
                  {[["chat", "Chat"], ["coding", "Coding"], ["summarization", "Summarization"], ["classification", "Classification"], ["agentic", "Agentic / tool use"], ["rag", "RAG / grounded answers"], ["vision", "Vision analysis"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="panel">
                <PanelTitle icon={<CircleGauge size={17} />} label="Service level" detail="Latency and quality" />
                <div className="split-controls">
                  <select aria-label="Latency requirement" value={profile.latencyRequirement} onChange={(event) => update("latencyRequirement", event.target.value)}>
                    <option value="real-time">Real-time</option><option value="interactive">Interactive</option><option value="batch">Batch</option>
                  </select>
                  <select aria-label="Quality bar" value={profile.qualityBar} onChange={(event) => update("qualityBar", event.target.value)}>
                    <option value="good-enough">Good enough</option><option value="high">High quality</option><option value="frontier">Frontier reasoning</option>
                  </select>
                </div>
              </div>
              <div className="panel span-two">
                <label htmlFor="use-case">Scenario details</label>
                <textarea
                  id="use-case"
                  value={profile.useCase}
                  onChange={(event) => update("useCase", event.target.value)}
                />
              </div>
              <div className="panel span-two">
                <label>Required modalities</label>
                <div className="segmented modality-options">
                  {["text", "vision", "audio", "video", "code"].map((value) => (
                    <button
                      key={value}
                      className={profile.modalities.includes(value) ? "selected" : ""}
                      aria-pressed={profile.modalities.includes(value)}
                      onClick={() => setProfile((current) => {
                        const selected = current.modalities.includes(value);
                        if (selected && current.modalities.length === 1) return current;
                        return {
                          ...current,
                          modalities: selected
                            ? current.modalities.filter((item) => item !== value)
                            : [...current.modalities, value],
                        };
                      })}
                    >
                      {value === "vision" ? "Images" : value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="panel">
                <PanelTitle
                  icon={<Globe2 size={17} />}
                  label="Deployment region"
                  detail="Residency and availability"
                />
                <select
                  aria-label="Deployment region"
                  value={profile.region}
                  onChange={(event) => update("region", event.target.value)}
                >
                  {[
                    "East US",
                    "East US 2",
                    "Sweden Central",
                    "West Europe",
                    "France Central",
                    "US",
                    "Europe",
                    "Global",
                    "Self-hosted",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
                <CheckRow
                  checked={profile.requireDataResidency}
                  onChange={(value) => update("requireDataResidency", value)}
                  label="Enforce data residency"
                />
              </div>
              <div className="panel">
                <PanelTitle
                  icon={<Database size={17} />}
                  label="Data shape"
                  detail="Minimum context window"
                />
                <select
                  aria-label="Minimum context window"
                  value={profile.minimumContext}
                  onChange={(event) =>
                    update("minimumContext", Number(event.target.value))
                  }
                >
                  <option value={8000}>8K tokens</option>
                  <option value={16000}>16K tokens</option>
                  <option value={128000}>128K tokens</option>
                  <option value={200000}>200K tokens</option>
                  <option value={1000000}>1M tokens</option>
                </select>
                <CheckRow
                  checked={profile.requireSelfHosting}
                  onChange={(value) => update("requireSelfHosting", value)}
                  label="Must support self-hosting"
                />
              </div>
              <div className="panel">
                <PanelTitle
                  icon={<CircleGauge size={17} />}
                  label="Cost and legal"
                  detail="Budget and agreement constraints"
                />
                <div className="money-input">
                  <span>$</span>
                  <input
                    aria-label="Maximum input cost"
                    type="number"
                    min="0"
                    step="0.1"
                    value={profile.maxInputCostPerMillion ?? ""}
                    onChange={(event) =>
                      update(
                        "maxInputCostPerMillion",
                        event.target.value ? Number(event.target.value) : null,
                      )
                    }
                  />
                </div>
                <CheckRow
                  checked={profile.openSourceOnly}
                  onChange={(value) => update("openSourceOnly", value)}
                  label="Open-weight models only"
                />
                <CheckRow
                  checked={profile.excludeAgreementRequired}
                  onChange={(value) =>
                    update("excludeAgreementRequired", value)
                  }
                  label="Exclude models requiring agreement"
                />
              </div>
              <div className="panel">
                <PanelTitle icon={<Database size={17} />} label="Workload" detail="Volume and monthly ceiling" />
                <div className="number-grid">
                  <label>Calls / day<input type="number" min="0" value={profile.callsPerDay} onChange={(event) => update("callsPerDay", Number(event.target.value))} /></label>
                  <label>Monthly $<input type="number" min="0" value={profile.monthlyBudgetUsd ?? ""} onChange={(event) => update("monthlyBudgetUsd", event.target.value ? Number(event.target.value) : null)} /></label>
                  <label>Input tokens<input type="number" min="0" value={profile.averageInputTokens} onChange={(event) => update("averageInputTokens", Number(event.target.value))} /></label>
                  <label>Output tokens<input type="number" min="0" value={profile.averageOutputTokens} onChange={(event) => update("averageOutputTokens", Number(event.target.value))} /></label>
                </div>
              </div>
              <div className="panel">
                <PanelTitle icon={<Wrench size={17} />} label="Output contract" detail="Required API behavior" />
                <CheckRow checked={profile.requireStructuredJson} onChange={(value) => update("requireStructuredJson", value)} label="Structured JSON" />
                <CheckRow checked={profile.requireToolCalling} onChange={(value) => update("requireToolCalling", value)} label="Native tool calling" />
                <CheckRow checked={profile.requireStreaming} onChange={(value) => update("requireStreaming", value)} label="Token streaming" />
              </div>
              <div className="panel">
                <PanelTitle icon={<Layers3 size={17} />} label="Compute and tuning" detail="Hosting requirements" />
                <select aria-label="Compute preference" value={profile.computePreference} onChange={(event) => update("computePreference", event.target.value)}>
                  <option value="any">Any compute</option><option value="managed">Managed endpoint</option><option value="self-hosted-gpu">Self-hosted GPU</option>
                </select>
                <CheckRow checked={profile.requireFineTuning} onChange={(value) => update("requireFineTuning", value)} label="Fine-tuning required" />
              </div>
              <div className="panel priorities">
                <PanelTitle
                  icon={<BarChart3 size={17} />}
                  label="Ranking priorities"
                  detail="Relative weights"
                />
                {(["quality", "cost", "speed", "safety"] as const).map(
                  (name) => {
                    const key = `${name}Weight` as keyof Profile;
                    return (
                      <Weight
                        key={name}
                        label={name}
                        value={profile[key] as number}
                        onChange={(value) => update(key, value)}
                      />
                    );
                  },
                )}
              </div>
            </div>
            {message && <div className="notice">{message}</div>}
            <div className="actions">
              <span>Hard constraints are applied before weighted scoring.</span>
              <button
                className="primary-button"
                onClick={findModels}
                disabled={loading}
              >
                {loading ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Sparkles size={17} />
                )}
                Analyze models
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
        )}

        {step === "compare" && (
          <section className="workspace-section reveal">
            <Heading
              eyebrow="RECOMMENDED SHORTLIST"
              title="Best fits for your constraints"
              copy="Scores reflect your priorities. Open each official source before making a production decision."
              index="02"
            />
            {message && <div className="notice">{message}</div>}
            <div className="legal-disclaimer">
              <Scale size={16} />
              <span>
                License summaries support triage, not legal advice. Verify
                current provider terms and obtain counsel for regulated or
                high-impact uses.
              </span>
            </div>
            <div className="recommendation-list">
              {recommendations.map((item, index) => (
                <article className="model-row" key={item.model.id}>
                  <div className="rank">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <div className="model-identity">
                    <span>{item.model.provider}</span>
                    <h2>{item.model.name}</h2>
                    <p>{item.model.bestFor}</p>
                    <details className="evidence-details">
                      <summary><BarChart3 size={12} />Model evidence<b>{item.model.evidence.toolUse.supported ? "Tool use" : "No native tools"}</b></summary>
                      <div className="evidence-content">
                        <strong>Why it was shortlisted</strong>
                        <ul>{item.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                        <strong>Benchmark signals</strong>
                        <div className="benchmark-grid">{item.model.evidence.benchmarks.map((benchmark) => <a key={benchmark.name} href={benchmark.sourceUrl} target="_blank" rel="noreferrer" title={benchmark.methodology}><span>{benchmark.name}</span><b>{benchmark.value}</b></a>)}</div>
                        <div className="capability-note"><Wrench size={12} /><span><b>Tools:</b> {item.model.evidence.toolUse.summary}</span></div>
                        <div className="capability-note"><Layers3 size={12} /><span><b>Compute:</b> {item.model.operations.compute.summary} {item.model.operations.compute.fineTuningSupported ? "Fine-tuning supported." : "No verified fine-tuning path."}</span></div>
                        <div className="capability-note"><Database size={12} /><span><b>Output:</b> {item.model.operations.output.summary}</span></div>
                        <div className={`access-note ${item.model.operations.access.gated ? "gated" : ""}`}><ShieldCheck size={12} /><span><b>{item.model.operations.access.gated ? "Gated access" : item.model.operations.access.accessType}</b> · {item.model.operations.access.summary} <a href={item.model.operations.access.applyUrl} target="_blank" rel="noreferrer">{item.model.operations.access.gated ? "Apply for access" : "Open access page"} <ExternalLink size={10} /></a></span></div>
                        <div className={`lifecycle-note ${item.model.operations.lifecycle.status.toLowerCase() !== "active" ? "warning" : ""}`}><RefreshCw size={12} /><span><b>{item.model.operations.lifecycle.urgency} · {item.model.operations.lifecycle.status}{item.model.operations.lifecycle.modelVersion && ` · ${item.model.operations.lifecycle.modelVersion}`}</b> · {item.model.operations.lifecycle.releasedAt && `Released ${new Date(item.model.operations.lifecycle.releasedAt).toLocaleDateString()}. `}{item.model.operations.lifecycle.deprecationDate && `Deprecated ${new Date(item.model.operations.lifecycle.deprecationDate).toLocaleDateString()}. `}{item.model.operations.lifecycle.retirementDate && `Retires ${new Date(item.model.operations.lifecycle.retirementDate).toLocaleDateString()}${item.model.operations.lifecycle.daysUntilRetirement !== null ? ` (${item.model.operations.lifecycle.daysUntilRetirement} days from catalog check)` : ""}. `}{item.model.operations.lifecycle.replacement && `Replace with ${item.model.operations.lifecycle.replacement}. `}{item.model.operations.lifecycle.summary} <a href={item.model.operations.lifecycle.sourceUrl} target="_blank" rel="noreferrer">Lifecycle source <ExternalLink size={10} /></a></span></div>
                        {item.model.evidence.speechLanguages.length > 0 && <div className="capability-note"><Languages size={12} /><span><b>Speech languages:</b> {item.model.evidence.speechLanguages.join(", ")}</span></div>}
                        <div className="weaknesses"><AlertTriangle size={12} /><div><b>Known weaknesses</b><ul>{item.model.evidence.knownWeaknesses.map((weakness) => <li key={weakness}>{weakness}</li>)}</ul></div></div>
                      </div>
                    </details>
                    <details
                      className={`legal-details ${item.model.legal.requiresAgreement ? "agreement" : ""}`}
                    >
                      <summary>
                        <Scale size={12} />
                        {item.model.legal.licenseName}
                        <b>
                          {item.model.legal.requiresAgreement
                            ? "Agreement required"
                            : "No separate acceptance"}
                        </b>
                      </summary>
                      <div>
                        <strong>
                          {item.model.legal.category} ·{" "}
                          {item.model.legal.commercialUse}
                        </strong>
                        <ul>
                          {item.model.legal.constraints.map((constraint) => (
                            <li key={constraint}>{constraint}</li>
                          ))}
                        </ul>
                        <a
                          href={item.model.legal.termsUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Review official terms <ExternalLink size={11} />
                        </a>
                      </div>
                    </details>
                  </div>
                  <Metric label="Quality" value={item.model.qualityScore} />
                  <Metric label="Speed" value={item.model.speedScore} />
                  <div className="metric">
                    <span>Input / 1M</span>
                    <strong>
                      ${item.model.inputCostPerMillion.toFixed(2)}
                    </strong>
                    <small>
                      {Math.round(item.model.contextWindow / 1000)}K context
                    </small>
                  </div>
                  <div className="fit-score">
                    <span>FIT SCORE</span>
                    <strong>{item.score}</strong>
                    <div className="score-track">
                      <i style={{ width: `${item.score}%` }} />
                    </div>
                  </div>
                  <div className="model-actions">
                    <button
                      className={`select-button ${selectedModels.includes(item.model.id) ? "selected" : ""}`}
                      onClick={() => toggleModel(item.model.id)}
                    >
                      {selectedModels.includes(item.model.id) && (
                        <Check size={14} />
                      )}
                      Test
                    </button>
                    <a
                      href={item.model.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open official model source"
                    >
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </article>
              ))}
            </div>
            {(costOptimizations.length > 0 || modelRouter) && (
              <div className="decision-tools">
                <section className="optimization-panel">
                  <div className="decision-heading"><CircleGauge size={17} /><div><strong>Cost optimization</strong><span>Projected opportunities for this workload</span></div></div>
                  {costOptimizations.map((optimization) => <article key={optimization.title}><div><strong>{optimization.title}</strong><p>{optimization.detail}</p></div><b>{optimization.estimatedMonthlySavingsUsd > 0 ? `$${optimization.estimatedMonthlySavingsUsd.toFixed(2)}/mo` : "Baseline"}</b></article>)}
                </section>
                {modelRouter && <section className="router-panel">
                  <div className="decision-heading"><Layers3 size={17} /><div><strong>Microsoft Foundry Model Router</strong><span>Managed model deployment, not application-side routing</span></div></div>
                  <div className="router-summary"><div><span>MODEL</span><strong>{modelRouter.modelName}</strong><small>Version {modelRouter.version}</small></div><div><span>RECOMMENDED MODE</span><strong>{modelRouter.routingMode}</strong><small>Balanced is Foundry's default</small></div></div>
                  <p className="router-copy">{modelRouter.summary}</p>
                  <div className="router-columns"><div><strong>Why consider it</strong><ul>{modelRouter.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul></div><div><strong>Before deployment</strong><ul>{modelRouter.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul></div></div>
                  <div className="router-links"><a href={modelRouter.sourceUrl} target="_blank" rel="noreferrer">How it works <ExternalLink size={11} /></a><a className="primary-button compact" href={modelRouter.deploymentUrl} target="_blank" rel="noreferrer">Deployment guide <ExternalLink size={12} /></a></div>
                </section>}
              </div>
            )}
            <div className="comparison-foot">
              <div>
                <strong>{selectedModels.length} models selected</strong>
                <span>
                  Compare them on examples in the evaluation workspace.
                </span>
              </div>
              <button
                className="primary-button"
                disabled={!selectedModels.length}
                onClick={() => setStep("evaluate")}
              >
                <FlaskConical size={17} />
                Build evaluation
                <ArrowRight size={17} />
              </button>
            </div>
          </section>
        )}

        {step === "evaluate" && (
          <section className="workspace-section reveal">
            <Heading
              eyebrow="EVALUATION LAB"
              title="Test with your own data"
              copy="Add prompts, documents, images, recordings, or video. Files are processed in memory and sent only to selected, configured providers."
              index="03"
            />
            {message && <div className="notice">{message}</div>}
            <div className="evaluation-grid">
              <div className="evaluation-data">
                <div className="panel evaluation-input">
                  <label htmlFor="samples">
                    Text examples <span className="optional">Optional</span>
                  </label>
                  <textarea
                    id="samples"
                    value={samples}
                    onChange={(event) => {
                      setSamples(event.target.value);
                      setEvaluationResults([]);
                      setEvaluationVerdict(null);
                    }}
                  />
                  <div className="dataset-meta">
                    <Database size={15} />
                    {samples.split("\n").filter(Boolean).length} examples
                    <span>One example per line</span>
                  </div>
                </div>
                <div className="panel media-input">
                  <div className="media-heading">
                    <div>
                      <label>
                        Your files <span className="optional">Optional</span>
                      </label>
                      <small>Documents, images, audio, and video</small>
                    </div>
                    <button
                      className={`record-button ${recording ? "recording" : ""}`}
                      onClick={recording ? stopRecording : startRecording}
                    >
                      {recording ? <Square size={14} /> : <Mic size={15} />}
                      {recording ? "Stop" : "Record audio"}
                    </button>
                  </div>
                  <div className="upload-policy">
                    <AlertTriangle size={17} />
                    <div>
                      <strong>Upload requirements</strong>
                      <span>25 MB per file · 8 files maximum</span>
                      <span>Images: JPG, JPEG, PNG, WEBP, GIF · Video: MP4, WEBM, MOV</span>
                      <span>Documents: PDF, TXT, MD, CSV, JSON · Audio: MP3, WAV, M4A, OGG, WEBM</span>
                    </div>
                  </div>
                  <button
                    className="drop-zone"
                    onClick={() => fileInput.current?.click()}
                    onDrop={(event: DragEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      addFiles(Array.from(event.dataTransfer.files));
                    }}
                    onDragOver={(event) => event.preventDefault()}
                  >
                    <Upload size={22} />
                    <strong>Choose files or drop them here</strong>
                    <span>PDF, text, CSV, JSON, image, audio, or video</span>
                  </button>
                  <input
                    ref={fileInput}
                    className="file-input"
                    type="file"
                    multiple
                    accept={ACCEPTED_FILES}
                    onChange={(event) => {
                      addFiles(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  {files.length > 0 && (
                    <div className="asset-list">
                      {files.map((file, index) => (
                        <MediaAsset
                          key={`${file.name}-${file.lastModified}-${index}`}
                          file={file}
                          onRemove={() => {
                            setFiles((current) =>
                              current.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            );
                            setEvaluationResults([]);
                            setEvaluationVerdict(null);
                          }}
                        />
                      ))}
                    </div>
                  )}
                  {incompatibleModels.length > 0 && (
                    <div className="compatibility-warning" role="alert">
                      <AlertTriangle size={16} />
                      <div>
                        <strong>Selected model and file type do not match</strong>
                        {incompatibleModels.map((item) => (
                          <span key={item.name}>
                            {item.name} does not support {item.unsupported.join(" or ")} input.
                          </span>
                        ))}
                        <span>Remove those files or select a compatible model to continue.</span>
                      </div>
                    </div>
                  )}
                  <p className="privacy-note">
                    <ShieldCheck size={14} />
                    Uploads are not persisted by Model Compass. Provider
                    retention policies may still apply.
                  </p>
                </div>
              </div>
              <div className="panel run-config">
                <label>Run mode</label>
                <div className="segmented eval-mode">
                  <button
                    className={evaluationMode === "demo" ? "selected" : ""}
                    onClick={() => {
                      setEvaluationMode("demo");
                      setEvaluationResults([]);
                      setEvaluationVerdict(null);
                    }}
                  >
                    Demo
                  </button>
                  <button
                    className={evaluationMode === "live" ? "selected" : ""}
                    onClick={() => {
                      setEvaluationMode("live");
                      setEvaluationResults([]);
                      setEvaluationVerdict(null);
                    }}
                  >
                    Live provider
                  </button>
                </div>
                <p className="mode-description">
                  {evaluationMode === "demo"
                    ? "Uses clearly marked simulated responses. No API key or provider call."
                    : "Runs against endpoints configured securely on the API server."}
                </p>
                {evaluationMode === "live" && (
                  <div className="live-connection">
                    <label>Inference provider</label>
                    <div className="segmented connection-choice">
                      <button className={liveConnection === "microsoft" ? "selected" : ""} onClick={() => setLiveConnection("microsoft")}>Microsoft Foundry</button>
                      <button className={liveConnection === "openai" ? "selected" : ""} onClick={() => setLiveConnection("openai")}>OpenAI</button>
                    </div>
                    <div className="connector-help">
                      <strong>{liveConnection === "microsoft" ? "Foundry / Azure OpenAI server configuration" : "OpenAI server configuration"}</strong>
                      <code>Providers__{liveConnection === "microsoft" ? "Microsoft" : "OpenAI"}__Endpoint</code>
                      <code>Providers__{liveConnection === "microsoft" ? "Microsoft" : "OpenAI"}__ApiKey</code>
                      {liveConnection === "microsoft" && <><code>Providers__Microsoft__Authentication=EntraId</code><code>Providers__Microsoft__Models__MODEL_ID=DEPLOYMENT_NAME</code></>}
                      <span>Use an API key, or EntraId for Microsoft. Set variables on the API server and restart it.</span>
                    </div>
                  </div>
                )}
                <label className="models-label">Models under test</label>
                {recommendations
                  .filter((item) => selectedModels.includes(item.model.id))
                  .map((item) => (
                    <div className="run-model" key={item.model.id}>
                      <span>
                        {item.model.name}
                        <small>
                          {item.model.provider} ·{" "}
                          {item.model.modalities.join(", ")}
                        </small>
                      </span>
                      <Check size={16} />
                    </div>
                  ))}
                <button
                  className="primary-button full"
                  onClick={runEvaluation}
                  disabled={
                    (!samples.trim() && !files.length) ||
                    !selectedModels.length ||
                    incompatibleModels.length > 0 ||
                    evaluationRunning
                  }
                >
                  {evaluationRunning ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <FlaskConical size={17} />
                  )}
                  {evaluationMode === "demo"
                    ? "Run demo evaluation"
                    : "Run live evaluation"}
                </button>
              </div>
            </div>
            {evaluationResults.length > 0 && (
              <div className="results-panel reveal">
                <div className="results-head">
                  <div>
                    <span className="eyebrow">RUN RESULTS</span>
                    <h2>
                      {evaluationMode === "demo"
                        ? "Simulated evaluation"
                        : "Provider evaluation"}
                    </h2>
                  </div>
                  <span className="estimate-badge">
                    {evaluationMode === "demo" ? "DEMO · " : ""}
                    {
                      evaluationResults.filter(
                        (item) => item.status === "completed",
                      ).length
                    }{" "}
                    of {evaluationResults.length} ran
                  </span>
                </div>
                {evaluationResults.every(
                  (item) => item.status !== "completed",
                ) && (
                  <div className="results-explanation">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>No evaluations ran</strong>
                      <span>
                        The models are shortlisted, but their provider
                        connections are not set up. Ask the workspace
                        administrator to connect the provider APIs, then run
                        this evaluation again.
                      </span>
                    </div>
                  </div>
                )}
                {evaluationVerdict && (
                  <div className="evaluation-verdict">
                    <Trophy size={20} />
                    <div><span>RECOMMENDED AFTER THIS RUN</span><strong>{evaluationVerdict.modelName}</strong><p>{evaluationVerdict.reasons.join(" · ")}</p><small>{evaluationVerdict.metricsEstimated ? "Uses simulated token, cost, and latency estimates; confirm with a live run." : "Uses catalog quality plus observed provider metrics from this run."}</small></div>
                    <b>{evaluationVerdict.score}</b>
                  </div>
                )}
                <div className="results-table">
                  <div className="results-row header">
                    <span>Model</span>
                    <span>Result</span>
                    <span>Tokens</span>
                    <span>Est. cost</span>
                    <span>Avg. latency</span>
                    <span>Responses</span>
                  </div>
                  {evaluationResults.map((item) => {
                    return (
                      <div className="results-row" key={item.modelId}>
                        <strong>{item.modelName}</strong>
                        <ResultStatus status={item.status} />
                        <span className="token-metric">
                          {item.usage ? <><b>{item.usage.totalTokens.toLocaleString()}</b><small>{item.usage.inputTokens.toLocaleString()} in / {item.usage.outputTokens.toLocaleString()} out</small></> : "Not reported"}
                        </span>
                        <span>{item.estimatedCostUsd != null ? `$${item.estimatedCostUsd.toFixed(6)}` : "Not reported"}</span>
                        <span>
                          {item.averageLatencyMs
                            ? `${Math.round(item.averageLatencyMs)} ms`
                            : "Not measured"}
                        </span>
                        <span>
                          {item.status === "completed"
                            ? item.outputs.length
                            : "-"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {evaluationResults.some((item) => item.outputs.length) && (
                  <div className="output-previews">
                    <span className="eyebrow">RESPONSE PREVIEW</span>
                    {evaluationResults
                      .filter((item) => item.outputs.length)
                      .map((item) => (
                        <div className="output-group" key={item.modelId}>
                          <strong>{item.modelName}</strong>
                          {item.outputs.map((output, index) => (
                            <pre key={index}>{output}</pre>
                          ))}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function Heading({
  eyebrow,
  title,
  copy,
  index,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  index: string;
}) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      <div className="heading-index">{index}</div>
    </div>
  );
}
function PanelTitle({
  icon,
  label,
  detail,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <div className="panel-title">
      {icon}
      <div>
        <label>{label}</label>
        <small>{detail}</small>
      </div>
    </div>
  );
}
function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="check-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="check-box">{checked && <Check size={13} />}</span>
      {label}
    </label>
  );
}
function Weight({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="weight">
      <span>{label}</span>
      <input
        aria-label={`${label} weight`}
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <strong>{value}</strong>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <div className="mini-track">
        <i style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
function ResultStatus({ status }: { status: string }) {
  const label =
    status === "completed"
      ? "Completed"
      : status === "connector-required"
        ? "Not run"
        : status === "unsupported-modality"
          ? "Incompatible data"
          : "Failed";
  return <span className={`result-status ${status}`}>{label}</span>;
}
function MediaAsset({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => setUrl(String(reader.result ?? "")));
    reader.readAsDataURL(file);
    return () => reader.abort();
  }, [file]);
  const icon = file.type.startsWith("image/") ? (
    <Image size={17} />
  ) : file.type.startsWith("audio/") ? (
    <AudioLines size={17} />
  ) : file.type.startsWith("video/") ? (
    <Video size={17} />
  ) : (
    <FileText size={17} />
  );
  return (
    <div className="asset-row">
      <div className="asset-preview">
        {file.type.startsWith("image/") ? (
          <img src={url} alt="" />
        ) : file.type.startsWith("video/") ? (
          <video src={url} muted />
        ) : (
          icon
        )}
      </div>
      <div className="asset-copy">
        <strong>{file.name}</strong>
        <span>
          {file.type || "Unknown type"} · {(file.size / 1024 / 1024).toFixed(1)}{" "}
          MB
        </span>
        {file.type.startsWith("audio/") && <audio controls src={url} />}
      </div>
      <button
        className="remove-asset"
        onClick={onRemove}
        title="Remove file"
        aria-label={`Remove ${file.name}`}
      >
        <X size={15} />
      </button>
    </div>
  );
}
