import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { storyboardVersions, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";

/**
 * Delete a storyboard version.
 *
 * The shots.versionId column has onDelete: "cascade", so deleting a
 * version wipes its shots; shots in turn cascade-delete dialogues +
 * shot_assets. Empty failed versions therefore clean up entirely
 * with a single row delete.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id: projectId, versionId } = await params;
  const userId = getUserIdFromRequest(request);

  // 1. Confirm the project belongs to this user.
  const [owner] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
  if (!owner) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Confirm the version belongs to this project (catches bogus
  //    versionId values the user could otherwise guess at).
  const [existing] = await db
    .select({ id: storyboardVersions.id })
    .from(storyboardVersions)
    .where(
      and(
        eq(storyboardVersions.id, versionId),
        eq(storyboardVersions.projectId, projectId),
      ),
    );
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await db.delete(storyboardVersions).where(eq(storyboardVersions.id, versionId));
  return NextResponse.json({ ok: true });
}
