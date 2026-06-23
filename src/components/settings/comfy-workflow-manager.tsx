"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api-fetch";
import { Trash2, Upload } from "lucide-react";

type Capability = "image" | "video";

interface Workflow {
  id: string;
  name: string;
  capability: Capability;
  outputNodeId: string | null;
}

interface ComfyWorkflowManagerProps {
  projectId: string;
  capability?: Capability;
}

export function ComfyWorkflowManager({ projectId, capability }: ComfyWorkflowManagerProps) {
  const t = useTranslations();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [name, setName] = useState("");
  const [cap, setCap] = useState<Capability>(capability ?? "image");
  const [json, setJson] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const url = capability
      ? `/api/projects/${projectId}/comfy-workflows?capability=${capability}`
      : `/api/projects/${projectId}/comfy-workflows`;
    apiFetch(url)
      .then((res) => res.json())
      .then((data) => setWorkflows((data as { workflows: Workflow[] }).workflows ?? []))
      .catch(() => {});
  }, [projectId, capability]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !json.trim()) return;
    setLoading(true);
    try {
      await apiFetch(`/api/projects/${projectId}/comfy-workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, capability: cap, workflowJson: json }),
      });
      setName("");
      setJson("");
      const url = capability
        ? `/api/projects/${projectId}/comfy-workflows?capability=${capability}`
        : `/api/projects/${projectId}/comfy-workflows`;
      const refreshed = await apiFetch(url).then((res) => res.json()) as { workflows: Workflow[] };
      setWorkflows(refreshed.workflows ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/projects/${projectId}/comfy-workflows?workflowId=${id}`, { method: "DELETE" });
    const url = capability
      ? `/api/projects/${projectId}/comfy-workflows?capability=${capability}`
      : `/api/projects/${projectId}/comfy-workflows`;
    const refreshed = await apiFetch(url).then((res) => res.json()) as { workflows: Workflow[] };
    setWorkflows(refreshed.workflows ?? []);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result;
      if (typeof text === "string") {
        setJson(text);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-[--border-subtle] p-4">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("common.name")}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Image Workflow" />
        </div>
        {!capability && (
          <div className="space-y-1.5">
            <Label className="text-xs">Capability</Label>
            <select
              value={cap}
              onChange={(e) => setCap(e.target.value as Capability)}
              className="w-full rounded-lg border border-[--border-subtle] bg-transparent px-2.5 py-[7px] text-xs"
            >
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">Workflow JSON</Label>
          <Input type="file" accept=".json,application/json" onChange={handleFileChange} className="text-xs" />
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={8}
            placeholder="Paste ComfyUI workflow JSON here..."
            className="text-xs"
          />
        </div>
        <Button type="submit" size="sm" disabled={loading}>
          {loading ? (
            "..."
          ) : (
            <>
              <Upload className="mr-1 h-3 w-3" /> Upload
            </>
          )}
        </Button>
      </form>

      <div className="space-y-2">
        {workflows.map((w) => (
          <div
            key={w.id}
            className="flex items-center justify-between rounded-lg border border-[--border-subtle] px-3 py-2"
          >
            <div>
              <div className="text-sm font-medium">{w.name}</div>
              <div className="text-[10px] text-[--text-muted]">
                {w.capability} {w.outputNodeId ? `• output: ${w.outputNodeId}` : ""}
              </div>
            </div>
            <button
              onClick={() => handleDelete(w.id)}
              className="rounded p-1 hover:bg-red-50 hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
