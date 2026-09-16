import { signOut } from '@/server/auth';
import { errorResponse } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    await signOut();
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
