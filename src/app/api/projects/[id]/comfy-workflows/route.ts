import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { comfyWorkflows } from "@/lib/db/schema";
import { eq, and, isNull, or } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { detectOutputNodeId } from "@/lib/ai/providers/comfyui-workflows";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const { searchParams } = new URL(request.url);
  const capability = searchParams.get("capability") as "image" | "video" | null;

  const rows = await db
    .select()
    .from(comfyWorkflows)
    .where(
      capability
        ? and(
            eq(comfyWorkflows.capability, capability),
            or(eq(comfyWorkflows.projectId, projectId), isNull(comfyWorkflows.projectId)),
          )
        : or(eq(comfyWorkflows.projectId, projectId), isNull(comfyWorkflows.projectId)),
    );

  return NextResponse.json({ workflows: rows });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const body = (await request.json()) as {
    name: string;
    capability: "image" | "video";
    workflowJson: string;
    projectId?: string | null;
    outputNodeId?: string;
  };

  const workflow = JSON.parse(body.workflowJson) as Record<string, unknown>;
  const outputNodeId = body.outputNodeId ?? detectOutputNodeId(workflow);
  const id = genId();

  await db.insert(comfyWorkflows).values({
    id,
    projectId: body.projectId === undefined ? projectId : (body.projectId ?? null),
    name: body.name,
    capability: body.capability,
    workflowJson: body.workflowJson,
    outputNodeId,
  });

  return NextResponse.json({ id });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("workflowId");

  if (!workflowId) {
    return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  }

  await db.delete(comfyWorkflows).where(eq(comfyWorkflows.id, workflowId));

  return NextResponse.json({ ok: true });
}
