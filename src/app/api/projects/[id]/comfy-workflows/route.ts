import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { comfyWorkflows } from "@/lib/db/schema";
import { eq, and, isNull, or } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { detectOutputNodeId } from "@/lib/ai/providers/comfyui-workflows";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;

  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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

  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json()) as {
    name: string;
    capability: "image" | "video";
    workflowJson: string;
    projectId?: string | null;
    outputNodeId?: string;
  };

  if (
    typeof body.name !== "string" ||
    body.name.trim() === "" ||
    typeof body.capability !== "string" ||
    body.capability.trim() === "" ||
    typeof body.workflowJson !== "string" ||
    body.workflowJson.trim() === ""
  ) {
    return NextResponse.json(
      { error: "name, capability, and workflowJson are required" },
      { status: 400 },
    );
  }

  if (body.capability !== "image" && body.capability !== "video") {
    return NextResponse.json(
      { error: "capability must be 'image' or 'video'" },
      { status: 400 },
    );
  }

  if (
    body.projectId !== undefined &&
    body.projectId !== null &&
    body.projectId !== projectId
  ) {
    return NextResponse.json(
      { error: "projectId must match the route project or be null" },
      { status: 400 },
    );
  }

  const effectiveProjectId =
    body.projectId === null ? null : projectId;

  let workflow: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.workflowJson) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return NextResponse.json(
        { error: "workflowJson must be a JSON object" },
        { status: 400 },
      );
    }
    workflow = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "workflowJson must be valid JSON" },
      { status: 400 },
    );
  }

  const outputNodeId =
    body.outputNodeId === undefined || body.outputNodeId === ""
      ? detectOutputNodeId(workflow)
      : body.outputNodeId;
  const id = genId();

  await db.insert(comfyWorkflows).values({
    id,
    projectId: effectiveProjectId,
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

  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("workflowId");

  if (!workflowId) {
    return NextResponse.json({ error: "workflowId required" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(comfyWorkflows)
    .where(eq(comfyWorkflows.id, workflowId));

  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [deleted] = await db
    .delete(comfyWorkflows)
    .where(eq(comfyWorkflows.id, workflowId))
    .returning();

  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
