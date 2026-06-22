import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, importLogs } from "@/lib/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const logs = await db
    .select()
    .from(importLogs)
    .where(eq(importLogs.projectId, projectId))
    .orderBy(asc(importLogs.createdAt));

  // Internal chunk-cache rows (written by the per-chunk retry path in
  // step 2) are stored in this same table so they survive across retries
  // and get cleared by DELETE. They're not meant for the UI — filter them
  // out so they neither clutter the log panel nor get picked up by the
  // page's `find(l.status === "done" && l.metadata)` lookup for the final
  // step-2 summary.
  const visible = logs.filter((l) => !l.message?.startsWith("[chunk-cache] "));

  return NextResponse.json(visible);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const userId = getUserIdFromRequest(request);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(importLogs).where(eq(importLogs.projectId, projectId));
  return new NextResponse(null, { status: 204 });
}
